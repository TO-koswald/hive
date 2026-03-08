import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import type { CodexManagerEvent } from './codex-app-server-manager'
import { asObject, asString, asNumber } from './codex-utils'

// ── Content delta extraction ──────────────────────────────────────

interface ContentDelta {
  kind: 'assistant' | 'reasoning'
  text: string
}

function extractContentDelta(event: CodexManagerEvent): ContentDelta | null {
  // The event mapper handles content.delta notifications which carry text
  // deltas for either assistant output or reasoning (thinking) output.

  // Direct textDelta on event (set by some notification formats)
  if (event.textDelta) {
    return { kind: 'assistant', text: event.textDelta }
  }

  const payload = asObject(event.payload)
  if (!payload) return null

  const delta = asObject(payload.delta)

  // Structured delta in payload
  if (delta) {
    const text = asString(delta.text)
    if (text) {
      const deltaType = asString(delta.type)
      const kind = deltaType === 'reasoning' ? 'reasoning' : 'assistant'
      return { kind, text }
    }
  }

  // Some formats put assistantText / reasoningText at payload level
  const assistantText = asString(payload.assistantText)
  if (assistantText) {
    return { kind: 'assistant', text: assistantText }
  }

  const reasoningText = asString(payload.reasoningText)
  if (reasoningText) {
    return { kind: 'reasoning', text: reasoningText }
  }

  return null
}

// ── Turn payload extraction ───────────────────────────────────────

interface TurnCompletedInfo {
  status: string
  error?: string
  usage?: Record<string, unknown>
  cost?: number
}

function extractTurnCompletedInfo(event: CodexManagerEvent): TurnCompletedInfo {
  const payload = asObject(event.payload)
  const turnObj = asObject(payload?.turn)

  const status = asString(turnObj?.status)
    ?? asString(payload?.state)
    ?? 'completed'

  const error = asString(turnObj?.error) ?? asString(payload?.error) ?? event.message

  const usage = asObject(turnObj?.usage) ?? asObject(payload?.usage)
  const cost = asNumber(turnObj?.cost) ?? asNumber(payload?.cost)

  return {
    status,
    ...(error && status === 'failed' ? { error } : {}),
    ...(usage ? { usage } : {}),
    ...(cost !== undefined ? { cost } : {})
  }
}

// ── Item payload extraction ───────────────────────────────────────

interface ItemInfo {
  toolName: string
  callId: string
  status?: string
  output?: unknown
}

function extractItemInfo(event: CodexManagerEvent): ItemInfo {
  const payload = asObject(event.payload)
  const item = asObject(payload?.item)

  const toolName = asString(item?.toolName)
    ?? asString(item?.name)
    ?? asString(item?.type)
    ?? asString(payload?.toolName)
    ?? 'unknown'

  const callId = asString(item?.id)
    ?? asString(event.itemId)
    ?? asString(payload?.itemId)
    ?? ''

  const status = asString(item?.status) ?? asString(payload?.status)
  const output = item?.output ?? payload?.output

  return {
    toolName,
    callId,
    ...(status ? { status } : {}),
    ...(output !== undefined ? { output } : {})
  }
}

// ── Task payload extraction ───────────────────────────────────────

interface TaskInfo {
  taskId: string
  status: string
  message?: string
  progress?: number
}

function extractTaskInfo(event: CodexManagerEvent): TaskInfo {
  const payload = asObject(event.payload)
  const task = asObject(payload?.task)

  const taskId = asString(task?.id) ?? asString(payload?.taskId) ?? ''
  const status = asString(task?.status)
    ?? asString(payload?.status)
    ?? 'unknown'
  const message = asString(task?.message) ?? asString(payload?.message) ?? event.message
  const progress = asNumber(task?.progress) ?? asNumber(payload?.progress)

  return {
    taskId,
    status,
    ...(message ? { message } : {}),
    ...(progress !== undefined ? { progress } : {})
  }
}

// ── Main mapper ───────────────────────────────────────────────────

/**
 * Maps a Codex app-server manager event into one or more OpenCodeStreamEvent
 * objects that the Hive renderer understands.
 *
 * Returns an array because a single Codex notification may produce multiple
 * stream events (e.g. turn/completed → message.updated + session.status).
 */
export function mapCodexEventToStreamEvents(
  event: CodexManagerEvent,
  hiveSessionId: string
): OpenCodeStreamEvent[] {
  const { method } = event

  // ── Content deltas (text streaming) ──────────────────────────
  if (method === 'content.delta') {
    const delta = extractContentDelta(event)
    if (!delta) return []

    return [{
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: { type: delta.kind === 'reasoning' ? 'reasoning' : 'text', text: delta.text }
    }]
  }

  // ── Turn started ──────────────────────────────────────────────
  if (method === 'turn/started') {
    return [{
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: { type: 'busy' } },
      statusPayload: { type: 'busy' }
    }]
  }

  // ── Turn completed ────────────────────────────────────────────
  if (method === 'turn/completed') {
    const info = extractTurnCompletedInfo(event)
    const events: OpenCodeStreamEvent[] = []

    if (info.status === 'failed') {
      events.push({
        type: 'session.error',
        sessionId: hiveSessionId,
        data: { error: info.error ?? 'Turn failed' }
      })
    }

    // Emit a message.updated with usage/cost info when available
    if (info.usage || info.cost !== undefined) {
      events.push({
        type: 'message.updated',
        sessionId: hiveSessionId,
        data: {
          ...(info.usage ? { usage: info.usage } : {}),
          ...(info.cost !== undefined ? { cost: info.cost } : {})
        }
      })
    }

    // Always emit idle status on turn completion
    events.push({
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: { type: 'idle' } },
      statusPayload: { type: 'idle' }
    })

    return events
  }

  // ── Item started (tool/command use) ──────────────────────────
  if (method === 'item.started' || method === 'item/started') {
    const item = extractItemInfo(event)
    return [{
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: { type: 'tool_use', toolName: item.toolName, callID: item.callId }
    }]
  }

  // ── Item updated ──────────��──────────────────────────────────
  if (method === 'item.updated' || method === 'item/updated') {
    const item = extractItemInfo(event)
    return [{
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: {
        type: 'tool_use',
        toolName: item.toolName,
        callID: item.callId,
        ...(item.status ? { status: item.status } : {})
      }
    }]
  }

  // ── Item completed ───────────────────────────────────────────
  if (method === 'item.completed' || method === 'item/completed') {
    const item = extractItemInfo(event)
    return [{
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: {
        type: 'tool_result',
        toolName: item.toolName,
        callID: item.callId,
        status: item.status ?? 'completed',
        ...(item.output !== undefined ? { output: item.output } : {})
      }
    }]
  }

  // ── Task lifecycle ───────────────────────────────────────────
  if (
    method === 'task.started' || method === 'task/started' ||
    method === 'task.progress' || method === 'task/progress' ||
    method === 'task.completed' || method === 'task/completed'
  ) {
    const task = extractTaskInfo(event)
    return [{
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: {
        type: 'task',
        taskId: task.taskId,
        status: task.status,
        ...(task.message ? { message: task.message } : {}),
        ...(task.progress !== undefined ? { progress: task.progress } : {})
      }
    }]
  }

  // ── Session state changed ────────────────────────────────────
  if (method === 'session.state.changed' || method === 'session/state/changed') {
    const payload = asObject(event.payload)
    const state = asString(payload?.state)

    if (state === 'error') {
      const reason = asString(payload?.reason)
        ?? asString(payload?.error)
        ?? event.message
        ?? 'Session entered error state'
      return [{
        type: 'session.error',
        sessionId: hiveSessionId,
        data: { error: reason }
      }]
    }

    // For running/ready states, emit status
    if (state === 'running') {
      return [{
        type: 'session.status',
        sessionId: hiveSessionId,
        data: { status: { type: 'busy' } },
        statusPayload: { type: 'busy' }
      }]
    }

    if (state === 'ready') {
      return [{
        type: 'session.status',
        sessionId: hiveSessionId,
        data: { status: { type: 'idle' } },
        statusPayload: { type: 'idle' }
      }]
    }

    return []
  }

  // ── Runtime error ────────────────────────────────────────────
  if (method === 'runtime.error' || method === 'runtime/error') {
    const payload = asObject(event.payload)
    const message = asString(payload?.message)
      ?? asString(payload?.error)
      ?? event.message
      ?? 'Runtime error'
    return [{
      type: 'session.error',
      sessionId: hiveSessionId,
      data: { error: message }
    }]
  }

  // ── Manager-level error events (stderr, process errors) ─────
  if (event.kind === 'error') {
    const message = event.message ?? 'Unknown error'
    return [{
      type: 'session.error',
      sessionId: hiveSessionId,
      data: { error: message }
    }]
  }

  // ── Unrecognized events → empty (silently drop) ─────────────
  return []
}
