/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import {
  mapCodexEventToStreamEvents
} from '../../../src/main/services/codex-event-mapper'
import type { CodexManagerEvent } from '../../../src/main/services/codex-app-server-manager'

// ── Helpers ──────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CodexManagerEvent>): CodexManagerEvent {
  return {
    id: 'evt-1',
    kind: 'notification',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: new Date().toISOString(),
    method: '',
    ...overrides
  }
}

const HIVE_SESSION = 'hive-session-abc'

describe('mapCodexEventToStreamEvents', () => {
  // ── Content deltas ──────────────────────────────────────────

  describe('content.delta', () => {
    it('maps assistant text delta (structured delta)', () => {
      const event = makeEvent({
        method: 'content.delta',
        payload: {
          delta: { type: 'text', text: 'Hello world' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: { type: 'text', text: 'Hello world' }
      })
    })

    it('maps reasoning text delta', () => {
      const event = makeEvent({
        method: 'content.delta',
        payload: {
          delta: { type: 'reasoning', text: 'Let me think...' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: { type: 'reasoning', text: 'Let me think...' }
      })
    })

    it('maps textDelta field on event', () => {
      const event = makeEvent({
        method: 'content.delta',
        textDelta: 'direct text'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({ type: 'text', text: 'direct text' })
    })

    it('maps assistantText at payload level', () => {
      const event = makeEvent({
        method: 'content.delta',
        payload: { assistantText: 'payload assistant text' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({ type: 'text', text: 'payload assistant text' })
    })

    it('maps reasoningText at payload level', () => {
      const event = makeEvent({
        method: 'content.delta',
        payload: { reasoningText: 'payload reasoning text' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({ type: 'reasoning', text: 'payload reasoning text' })
    })

    it('returns empty array for content.delta with no text', () => {
      const event = makeEvent({
        method: 'content.delta',
        payload: { delta: { type: 'unknown' } }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })
  })

  // ── Turn started ────────────────────────────────────────────

  describe('turn/started', () => {
    it('maps to session.status busy', () => {
      const event = makeEvent({ method: 'turn/started' })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'session.status',
        sessionId: HIVE_SESSION,
        data: { status: { type: 'busy' } },
        statusPayload: { type: 'busy' }
      })
    })
  })

  // ── Turn completed ──────────────────────────────────────────

  describe('turn/completed', () => {
    it('maps successful completion to idle status', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      // Should have at least the idle status event
      const statusEvents = result.filter((e) => e.type === 'session.status')
      expect(statusEvents).toHaveLength(1)
      expect(statusEvents[0].statusPayload).toEqual({ type: 'idle' })
    })

    it('maps failed turn to session.error + idle', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: { turn: { status: 'failed', error: 'Rate limit exceeded' } }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      const errorEvents = result.filter((e) => e.type === 'session.error')
      expect(errorEvents).toHaveLength(1)
      expect(errorEvents[0].data).toEqual({ error: 'Rate limit exceeded' })

      const statusEvents = result.filter((e) => e.type === 'session.status')
      expect(statusEvents).toHaveLength(1)
      expect(statusEvents[0].statusPayload).toEqual({ type: 'idle' })
    })

    it('includes usage info in message.updated when present', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: {
          turn: {
            status: 'completed',
            usage: { inputTokens: 100, outputTokens: 50 },
            cost: 0.003
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      const usageEvents = result.filter((e) => e.type === 'message.updated')
      expect(usageEvents).toHaveLength(1)
      expect((usageEvents[0].data as any).usage).toEqual({
        inputTokens: 100,
        outputTokens: 50
      })
      expect((usageEvents[0].data as any).cost).toBe(0.003)
    })

    it('handles turn/completed with no turn object (fallback status)', () => {
      const event = makeEvent({
        method: 'turn/completed',
        payload: {}
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      // Defaults to 'completed' status → just idle
      const statusEvents = result.filter((e) => e.type === 'session.status')
      expect(statusEvents).toHaveLength(1)
      expect(statusEvents[0].statusPayload).toEqual({ type: 'idle' })

      // No error events for default completion
      const errorEvents = result.filter((e) => e.type === 'session.error')
      expect(errorEvents).toHaveLength(0)
    })
  })

  // ── Item started ────────────────────────────────────────────

  describe('item.started / item/started', () => {
    it('maps item.started to tool_use part', () => {
      const event = makeEvent({
        method: 'item.started',
        payload: {
          item: { id: 'item-1', toolName: 'shell', type: 'command' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: { type: 'tool_use', toolName: 'shell', callID: 'item-1' }
      })
    })

    it('maps item/started (slash variant)', () => {
      const event = makeEvent({
        method: 'item/started',
        payload: {
          item: { id: 'item-2', name: 'file_edit' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).toolName).toBe('file_edit')
      expect((result[0].data as any).callID).toBe('item-2')
    })
  })

  // ── Item updated ────────────────────────────────────────────

  describe('item.updated / item/updated', () => {
    it('maps item.updated to tool_use with status', () => {
      const event = makeEvent({
        method: 'item.updated',
        payload: {
          item: { id: 'item-3', toolName: 'shell', status: 'running' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).type).toBe('tool_use')
      expect((result[0].data as any).status).toBe('running')
    })
  })

  // ── Item completed ──────────────────────────────────────────

  describe('item.completed / item/completed', () => {
    it('maps item.completed to tool_result', () => {
      const event = makeEvent({
        method: 'item.completed',
        payload: {
          item: {
            id: 'item-4',
            toolName: 'shell',
            status: 'completed',
            output: 'file created'
          }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'message.part.updated',
        sessionId: HIVE_SESSION,
        data: {
          type: 'tool_result',
          toolName: 'shell',
          callID: 'item-4',
          status: 'completed',
          output: 'file created'
        }
      })
    })

    it('defaults status to completed', () => {
      const event = makeEvent({
        method: 'item/completed',
        payload: {
          item: { id: 'item-5', name: 'file_read' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect((result[0].data as any).status).toBe('completed')
    })
  })

  // ── Task lifecycle ──────────────────────────────────────────

  describe('task events', () => {
    it('maps task.started', () => {
      const event = makeEvent({
        method: 'task.started',
        payload: {
          task: { id: 'task-1', status: 'running', message: 'Starting analysis' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].data).toEqual({
        type: 'task',
        taskId: 'task-1',
        status: 'running',
        message: 'Starting analysis'
      })
    })

    it('maps task.progress with progress value', () => {
      const event = makeEvent({
        method: 'task.progress',
        payload: {
          task: { id: 'task-2', status: 'running', progress: 0.5 }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).progress).toBe(0.5)
    })

    it('maps task/completed (slash variant)', () => {
      const event = makeEvent({
        method: 'task/completed',
        payload: {
          task: { id: 'task-3', status: 'completed' }
        }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).status).toBe('completed')
    })
  })

  // ── Session state changed ───────────────────────────────────

  describe('session.state.changed', () => {
    it('maps error state to session.error', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'error', reason: 'API key invalid' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'session.error',
        sessionId: HIVE_SESSION,
        data: { error: 'API key invalid' }
      })
    })

    it('maps running state to busy', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'running' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].statusPayload).toEqual({ type: 'busy' })
    })

    it('maps ready state to idle', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'ready' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].statusPayload).toEqual({ type: 'idle' })
    })

    it('returns empty for unknown state', () => {
      const event = makeEvent({
        method: 'session.state.changed',
        payload: { state: 'connecting' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })

    it('handles session/state/changed (slash variant)', () => {
      const event = makeEvent({
        method: 'session/state/changed',
        payload: { state: 'error', error: 'Connection lost' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('session.error')
      expect((result[0].data as any).error).toBe('Connection lost')
    })
  })

  // ── Runtime error ───────────────────────────────────────────

  describe('runtime.error', () => {
    it('maps runtime.error to session.error', () => {
      const event = makeEvent({
        method: 'runtime.error',
        payload: { message: 'OOM killed' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'session.error',
        sessionId: HIVE_SESSION,
        data: { error: 'OOM killed' }
      })
    })

    it('maps runtime/error (slash variant)', () => {
      const event = makeEvent({
        method: 'runtime/error',
        payload: { error: 'Sandbox violation' }
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).error).toBe('Sandbox violation')
    })

    it('falls back to event.message', () => {
      const event = makeEvent({
        method: 'runtime.error',
        message: 'fallback error message'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).error).toBe('fallback error message')
    })
  })

  // ── Manager-level error events ──────────────────────────────

  describe('error kind events', () => {
    it('maps error-kind events to session.error', () => {
      const event = makeEvent({
        kind: 'error',
        method: 'process/stderr',
        message: 'codex stderr output'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('session.error')
      expect((result[0].data as any).error).toBe('codex stderr output')
    })

    it('uses "Unknown error" for error events without message', () => {
      const event = makeEvent({
        kind: 'error',
        method: 'process/error'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(1)
      expect((result[0].data as any).error).toBe('Unknown error')
    })
  })

  // ── Unrecognized events ─────────────────────────────────────

  describe('unrecognized events', () => {
    it('returns empty array for unknown notification methods', () => {
      const event = makeEvent({
        kind: 'notification',
        method: 'some.unknown.event'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })

    it('returns empty array for session lifecycle events', () => {
      const event = makeEvent({
        kind: 'session',
        method: 'session/ready'
      })

      const result = mapCodexEventToStreamEvents(event, HIVE_SESSION)

      expect(result).toHaveLength(0)
    })
  })

  // ── Session ID passthrough ──────────────────────────────────

  describe('session ID passthrough', () => {
    it('uses the provided hiveSessionId in all events', () => {
      const event = makeEvent({
        method: 'content.delta',
        payload: { delta: { type: 'text', text: 'x' } }
      })

      const result = mapCodexEventToStreamEvents(event, 'custom-session-id')

      expect(result[0].sessionId).toBe('custom-session-id')
    })
  })
})
