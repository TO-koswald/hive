import type { BrowserWindow } from 'electron'

import type { AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { CODEX_CAPABILITIES } from './agent-sdk-types'
import { getAvailableCodexModels, getCodexModelInfo, CODEX_DEFAULT_MODEL } from './codex-models'
import { createLogger } from './logger'
import {
  CodexAppServerManager,
  type CodexManagerEvent
} from './codex-app-server-manager'
import { mapCodexEventToStreamEvents } from './codex-event-mapper'

const log = createLogger({ component: 'CodexImplementer' })

// ── Session state ─────────────────────────────────────────────────

export interface CodexSessionState {
  threadId: string
  hiveSessionId: string
  worktreePath: string
  status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  messages: unknown[]
}

export class CodexImplementer implements AgentSdkImplementer {
  readonly id = 'codex' as const
  readonly capabilities: AgentSdkCapabilities = CODEX_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private selectedModel: string = CODEX_DEFAULT_MODEL
  private selectedVariant: string | undefined
  private manager: CodexAppServerManager = new CodexAppServerManager()
  private sessions = new Map<string, CodexSessionState>()

  // ── Window binding ───────────────────────────────────────────────

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    log.info('Connecting', { worktreePath, hiveSessionId, model: this.selectedModel })

    const providerSession = await this.manager.startSession({
      cwd: worktreePath,
      model: this.selectedModel
    })

    const threadId = providerSession.threadId
    if (!threadId) {
      throw new Error('Codex session started but no thread ID was returned.')
    }

    const key = this.getSessionKey(worktreePath, threadId)
    const state: CodexSessionState = {
      threadId,
      hiveSessionId,
      worktreePath,
      status: this.mapProviderStatus(providerSession.status),
      messages: []
    }
    this.sessions.set(key, state)

    // Notify renderer that the session has materialized
    this.sendToRenderer('opencode:stream', {
      type: 'session.materialized',
      sessionId: hiveSessionId,
      data: { newSessionId: threadId, wasFork: false }
    })

    log.info('Connected', { worktreePath, hiveSessionId, threadId })
    return { sessionId: threadId }
  }

  async reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> {
    const key = this.getSessionKey(worktreePath, agentSessionId)

    // If session already exists locally, just update the hiveSessionId
    const existing = this.sessions.get(key)
    if (existing) {
      existing.hiveSessionId = hiveSessionId
      const sessionStatus = this.statusToHive(existing.status)
      log.info('Reconnect: session already registered, updated hiveSessionId', {
        worktreePath,
        agentSessionId,
        hiveSessionId,
        sessionStatus
      })
      return { success: true, sessionStatus, revertMessageID: null }
    }

    // Otherwise, start a new session with thread resume
    try {
      const providerSession = await this.manager.startSession({
        cwd: worktreePath,
        model: this.selectedModel,
        resumeThreadId: agentSessionId
      })

      const threadId = providerSession.threadId
      if (!threadId) {
        throw new Error('Codex session started but no thread ID was returned.')
      }

      const newKey = this.getSessionKey(worktreePath, threadId)
      const state: CodexSessionState = {
        threadId,
        hiveSessionId,
        worktreePath,
        status: this.mapProviderStatus(providerSession.status),
        messages: []
      }
      this.sessions.set(newKey, state)

      log.info('Reconnected via thread resume', { worktreePath, agentSessionId, threadId })
      return { success: true, sessionStatus: this.statusToHive(state.status), revertMessageID: null }
    } catch (error) {
      log.error(
        'Reconnect failed',
        error instanceof Error ? error : new Error(String(error)),
        { worktreePath, agentSessionId }
      )
      return { success: false }
    }
  }

  async disconnect(worktreePath: string, agentSessionId: string): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)

    if (!session) {
      log.warn('Disconnect: session not found, ignoring', { worktreePath, agentSessionId })
      return
    }

    // Stop the manager session
    this.manager.stopSession(agentSessionId)

    // Clean up local state
    this.sessions.delete(key)

    log.info('Disconnected', { worktreePath, agentSessionId })
  }

  async cleanup(): Promise<void> {
    log.info('Cleaning up CodexImplementer state', { sessionCount: this.sessions.size })

    // Stop all manager sessions
    this.manager.stopAll()

    // Clear local state
    this.sessions.clear()
    this.mainWindow = null
    this.selectedModel = CODEX_DEFAULT_MODEL
    this.selectedVariant = undefined
  }

  // ── Messaging ────────────────────────────────────────────────────

  async prompt(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      throw new Error(
        `Prompt failed: session not found for ${worktreePath} / ${agentSessionId}`
      )
    }

    // Extract text from message
    let text: string
    if (typeof message === 'string') {
      text = message
    } else {
      text = message
        .filter((part) => part.type === 'text')
        .map((part) => (part as { type: 'text'; text: string }).text)
        .join('\n')
    }

    if (!text.trim()) {
      log.warn('Prompt: empty text, ignoring', { worktreePath, agentSessionId })
      return
    }

    // Inject synthetic user message so getMessages() returns it
    const syntheticTimestamp = new Date().toISOString()
    session.messages.push({
      role: 'user',
      parts: [{ type: 'text', text, timestamp: syntheticTimestamp }],
      timestamp: syntheticTimestamp
    })

    // Emit busy status
    session.status = 'running'
    this.emitStatus(session.hiveSessionId, 'busy')

    log.info('Prompt: starting', {
      worktreePath,
      agentSessionId,
      hiveSessionId: session.hiveSessionId,
      textLength: text.length
    })

    // Set up event listener for streaming
    let assistantText = ''
    let reasoningText = ''
    let turnCompleted = false
    let turnFailed = false

    const handleEvent = (event: CodexManagerEvent) => {
      // Only handle events for this thread
      if (event.threadId !== session.threadId) return

      const streamEvents = mapCodexEventToStreamEvents(event, session.hiveSessionId)
      for (const streamEvent of streamEvents) {
        this.sendToRenderer('opencode:stream', streamEvent)
      }

      // Accumulate text for message history
      if (event.method === 'content.delta') {
        const payload = event.payload as Record<string, unknown> | undefined
        const delta = payload?.delta as Record<string, unknown> | undefined
        const deltaType = delta?.type as string | undefined

        const deltaText = (delta?.text as string)
          ?? (payload?.assistantText as string)
          ?? (payload?.reasoningText as string)
          ?? event.textDelta
          ?? ''

        if (deltaType === 'reasoning' || payload?.reasoningText) {
          reasoningText += deltaText
        } else {
          assistantText += deltaText
        }
      }

      // Detect turn completion and whether it failed
      if (event.method === 'turn/completed') {
        turnCompleted = true
        const payload = event.payload as Record<string, unknown> | undefined
        const turnObj = payload?.turn as Record<string, unknown> | undefined
        const status = (turnObj?.status as string) ?? (payload?.state as string)
        if (status === 'failed') {
          turnFailed = true
        }
      }
    }

    this.manager.on('event', handleEvent)

    try {
      const model = modelOverride?.modelID ?? this.selectedModel

      await this.manager.sendTurn(session.threadId, {
        text,
        model
      })

      // Wait for turn completion (the sendTurn starts the turn, but
      // events stream asynchronously via the manager's event emitter)
      await this.waitForTurnCompletion(session, () => turnCompleted)

      // Store assistant message
      const assistantParts: unknown[] = []
      if (assistantText) {
        assistantParts.push({
          type: 'text',
          text: assistantText,
          timestamp: new Date().toISOString()
        })
      }
      if (reasoningText) {
        assistantParts.push({
          type: 'reasoning',
          text: reasoningText,
          timestamp: new Date().toISOString()
        })
      }

      if (assistantParts.length > 0) {
        session.messages.push({
          role: 'assistant',
          parts: assistantParts,
          timestamp: new Date().toISOString()
        })
      }

      session.status = turnFailed ? 'error' : 'ready'
      this.emitStatus(session.hiveSessionId, 'idle')

      log.info('Prompt: completed', {
        worktreePath,
        agentSessionId,
        assistantTextLength: assistantText.length,
        reasoningTextLength: reasoningText.length
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error(
        'Prompt streaming error',
        error instanceof Error ? error : new Error(errorMessage),
        { worktreePath, agentSessionId, error: errorMessage }
      )

      session.status = 'error'
      this.sendToRenderer('opencode:stream', {
        type: 'session.error',
        sessionId: session.hiveSessionId,
        data: { error: errorMessage }
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } finally {
      this.manager.removeListener('event', handleEvent)
    }
  }

  async abort(_worktreePath: string, _agentSessionId: string): Promise<boolean> {
    throw new Error('CodexImplementer.abort() not yet implemented')
  }

  async getMessages(worktreePath: string, agentSessionId: string): Promise<unknown[]> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      log.warn('getMessages: session not found', { worktreePath, agentSessionId })
      return []
    }
    return [...session.messages]
  }

  // ── Models ───────────────────────────────────────────────────────

  async getAvailableModels(): Promise<unknown> {
    return getAvailableCodexModels()
  }

  async getModelInfo(
    _worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    return getCodexModelInfo(modelId)
  }

  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    this.selectedModel = model.modelID
    this.selectedVariant = model.variant
    log.info('Selected model set', { model: model.modelID, variant: model.variant })
  }

  // ── Session info ─────────────────────────────────────────────────

  async getSessionInfo(
    _worktreePath: string,
    _agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    throw new Error('CodexImplementer.getSessionInfo() not yet implemented')
  }

  // ── Human-in-the-loop ────────────────────────────────────────────

  async questionReply(
    _requestId: string,
    _answers: string[][],
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('CodexImplementer.questionReply() not yet implemented')
  }

  async questionReject(_requestId: string, _worktreePath?: string): Promise<void> {
    throw new Error('CodexImplementer.questionReject() not yet implemented')
  }

  async permissionReply(
    _requestId: string,
    _decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    throw new Error('CodexImplementer.permissionReply() not yet implemented')
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    throw new Error('CodexImplementer.permissionList() not yet implemented')
  }

  // ── Undo/Redo ────────────────────────────────────────────────────

  async undo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('CodexImplementer.undo() not yet implemented')
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('CodexImplementer.redo() not yet implemented')
  }

  // ── Commands ─────────────────────────────────────────────────────

  async listCommands(_worktreePath: string): Promise<unknown[]> {
    throw new Error('CodexImplementer.listCommands() not yet implemented')
  }

  async sendCommand(
    _worktreePath: string,
    _agentSessionId: string,
    _command: string,
    _args?: string
  ): Promise<void> {
    throw new Error('CodexImplementer.sendCommand() not yet implemented')
  }

  // ── Session management ───────────────────────────────────────────

  async renameSession(
    _worktreePath: string,
    _agentSessionId: string,
    _name: string
  ): Promise<void> {
    throw new Error('CodexImplementer.renameSession() not yet implemented')
  }

  // ── Internal helpers (exposed for testing) ───────────────────────

  /** @internal */
  getSelectedModel(): string {
    return this.selectedModel
  }

  /** @internal */
  getSelectedVariant(): string | undefined {
    return this.selectedVariant
  }

  /** @internal */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  /** @internal */
  getManager(): CodexAppServerManager {
    return this.manager
  }

  /** @internal */
  getSessions(): Map<string, CodexSessionState> {
    return this.sessions
  }

  // ── Private helpers ──────────────────────────────────────────────

  private getSessionKey(worktreePath: string, agentSessionId: string): string {
    return `${worktreePath}::${agentSessionId}`
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    } else {
      log.debug('sendToRenderer: no window (headless)')
    }
  }

  private mapProviderStatus(
    status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  ): CodexSessionState['status'] {
    return status
  }

  private statusToHive(
    status: CodexSessionState['status']
  ): 'idle' | 'busy' | 'retry' {
    if (status === 'running') return 'busy'
    return 'idle'
  }

  private emitStatus(
    hiveSessionId: string,
    status: 'idle' | 'busy' | 'retry',
    extra?: { attempt?: number; message?: string; next?: number }
  ): void {
    const statusPayload = { type: status, ...extra }
    this.sendToRenderer('opencode:stream', {
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: statusPayload },
      statusPayload
    })
  }

  private waitForTurnCompletion(
    session: CodexSessionState,
    isComplete: () => boolean,
    timeoutMs = 300_000
  ): Promise<void> {
    if (isComplete()) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Turn timed out'))
      }, timeoutMs)

      const checkEvent = (event: CodexManagerEvent) => {
        if (event.threadId !== session.threadId) return

        if (event.method === 'turn/completed') {
          cleanup()
          resolve()
          return
        }

        // Reject immediately on error events so prompt() doesn't hang
        // when the Codex process crashes or enters an unrecoverable state.
        if (event.kind === 'error') {
          cleanup()
          reject(new Error(event.message ?? 'Codex process error'))
          return
        }

        const isErrorStateChange =
          (event.method === 'session.state.changed' ||
            event.method === 'session/state/changed') &&
          (event.payload as Record<string, unknown> | undefined)?.state === 'error'

        if (isErrorStateChange) {
          const payload = event.payload as Record<string, unknown>
          const reason = (payload?.reason as string)
            ?? (payload?.error as string)
            ?? event.message
            ?? 'Session entered error state'
          cleanup()
          reject(new Error(reason))
        }
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.manager.removeListener('event', checkEvent)
      }

      this.manager.on('event', checkEvent)

      // Check again in case it completed between the start and listener setup
      if (isComplete()) {
        cleanup()
        resolve()
      }
    })
  }
}
