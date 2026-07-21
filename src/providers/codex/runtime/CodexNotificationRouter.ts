import type { ChatTurnMetadata } from '../../../core/runtime/types';
import type { StreamChunk, UsageInfo } from '../../../core/types';
import { extractCodexUserVisibleText, joinCodexUserTextParts } from '../codexUserText';
import {
  appendCodexCommandOutput,
  decodeCodexExecEnvelope,
  extractCodexExecCellId,
  isCodexToolOutputError,
  normalizeCodexToolCall,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
  readCodexExecCellIdArgument,
  splitCodexExecEnvelopeOutput,
  stringifyCodexToolOutput,
} from '../normalization/codexToolNormalization';
import type {
  AgentMessageDeltaNotification,
  AgentMessageItem,
  CollabAgentToolCallItem,
  CommandExecutionItem,
  ContextCompactionItem,
  DynamicToolCallItem,
  ErrorNotification,
  FileChangeItem,
  FileChangePatchUpdatedNotification,
  ImageViewItem,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpToolCallItem,
  PlanDeltaNotification,
  ReasoningSummaryTextDeltaNotification,
  ReasoningTextDeltaNotification,
  TokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
  UserInput,
  UserMessageItem,
  WebSearchItem,
} from './codexAppServerTypes';

type ChunkEmitter = (chunk: StreamChunk) => void;
type TurnMetadataListener = (update: Partial<ChatTurnMetadata>) => void;

interface RawToolResult {
  content: string;
  isError: boolean;
}

interface WrappedWaitCall {
  commandCallId: string;
  cellId: string;
}

interface RawExecEnvelopeCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface PendingRawImageWrapper {
  callId: string;
  path: string;
}

const COLLAB_AGENT_TOOL_MAP: Record<string, string> = {
  spawnAgent: 'spawn_agent',
  wait: 'wait',
  sendInput: 'send_input',
  resumeAgent: 'resume_agent',
  closeAgent: 'close_agent',
};

export class CodexNotificationRouter {
  private seenWebSearchIds = new Set<string>();
  private planUpdateCounter = 0;
  private isPlanTurn = false;
  private sawPlanDelta = false;
  private startedUserMessageIds = new Set<string>();
  private startedAgentMessageIds = new Set<string>();
  private agentMessageDeltaIds = new Set<string>();
  private streamedAssistantTurnText = '';
  private currentAssistantSegmentId: string | undefined;
  private currentAssistantSegmentText = '';
  private rawStartedCallIds = new Set<string>();
  private rawToolNamesByCallId = new Map<string, string>();
  private rawToolInputsByCallId = new Map<string, Record<string, unknown>>();
  private rawToolOutputsByCallId = new Map<string, RawToolResult>();
  private immediateRawOutputCallIds = new Set<string>();
  private emittedImmediateToolResultIds = new Set<string>();
  private wrappedCommandCallIdsByCellId = new Map<string, string>();
  private wrappedCommandOutputByCallId = new Map<string, string>();
  private wrappedWaitCallsByCallId = new Map<string, WrappedWaitCall>();
  private rawExecEnvelopeCallsByCallId = new Map<string, RawExecEnvelopeCall[]>();
  private rawCommandWrapperIdsByFingerprint = new Map<string, string[]>();
  private pendingRawImageWrappers: PendingRawImageWrapper[] = [];
  private suppressedSemanticCommandIds = new Set<string>();
  private suppressedSemanticImageIds = new Set<string>();
  private suppressedRawCallIds = new Set<string>();
  private fileChangeInputsById = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly emit: ChunkEmitter,
    private readonly onTurnMetadata?: TurnMetadataListener,
  ) {}

  private resetAssistantTextTracking(): void {
    this.streamedAssistantTurnText = '';
    this.resetAssistantSegmentText();
  }

  private resetAssistantSegmentText(): void {
    this.currentAssistantSegmentId = undefined;
    this.currentAssistantSegmentText = '';
  }

  private beginAssistantSegment(itemId: string): void {
    if (this.currentAssistantSegmentId === itemId) {
      return;
    }

    this.currentAssistantSegmentId = itemId;
    this.currentAssistantSegmentText = '';
  }

  private claimAssistantSegment(itemId?: string): void {
    if (!itemId) {
      return;
    }

    if (this.currentAssistantSegmentId && this.currentAssistantSegmentId !== itemId) {
      this.beginAssistantSegment(itemId);
      return;
    }

    if (!this.currentAssistantSegmentId) {
      this.currentAssistantSegmentId = itemId;
    }
  }

  private appendAssistantText(text: string, itemId?: string): void {
    if (!text) {
      return;
    }

    this.claimAssistantSegment(itemId);

    this.currentAssistantSegmentText += text;
    this.streamedAssistantTurnText += text;
  }

  beginTurn(params: { isPlanTurn: boolean }): void {
    this.isPlanTurn = params.isPlanTurn;
    this.sawPlanDelta = false;
    this.startedUserMessageIds.clear();
    this.startedAgentMessageIds.clear();
    this.agentMessageDeltaIds.clear();
    this.resetAssistantTextTracking();
    this.rawStartedCallIds.clear();
    this.rawToolNamesByCallId.clear();
    this.rawToolInputsByCallId.clear();
    this.rawToolOutputsByCallId.clear();
    this.immediateRawOutputCallIds.clear();
    this.emittedImmediateToolResultIds.clear();
    this.wrappedCommandCallIdsByCellId.clear();
    this.wrappedCommandOutputByCallId.clear();
    this.wrappedWaitCallsByCallId.clear();
    this.rawExecEnvelopeCallsByCallId.clear();
    this.rawCommandWrapperIdsByFingerprint.clear();
    this.pendingRawImageWrappers = [];
    this.suppressedSemanticCommandIds.clear();
    this.suppressedSemanticImageIds.clear();
    this.suppressedRawCallIds.clear();
    this.fileChangeInputsById.clear();
  }

  endTurn(): void {
    this.isPlanTurn = false;
    this.sawPlanDelta = false;
    this.startedUserMessageIds.clear();
    this.startedAgentMessageIds.clear();
    this.agentMessageDeltaIds.clear();
    this.resetAssistantTextTracking();
    this.rawStartedCallIds.clear();
    this.rawToolNamesByCallId.clear();
    this.rawToolInputsByCallId.clear();
    this.rawToolOutputsByCallId.clear();
    this.immediateRawOutputCallIds.clear();
    this.emittedImmediateToolResultIds.clear();
    this.wrappedCommandCallIdsByCellId.clear();
    this.wrappedCommandOutputByCallId.clear();
    this.wrappedWaitCallsByCallId.clear();
    this.rawExecEnvelopeCallsByCallId.clear();
    this.rawCommandWrapperIdsByFingerprint.clear();
    this.pendingRawImageWrappers = [];
    this.suppressedSemanticCommandIds.clear();
    this.suppressedSemanticImageIds.clear();
    this.suppressedRawCallIds.clear();
    this.fileChangeInputsById.clear();
  }

  handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'item/agentMessage/delta':
        this.onAgentMessageDelta(params as AgentMessageDeltaNotification);
        break;
      case 'item/started':
        this.onItemStarted(params as ItemStartedNotification);
        break;
      case 'item/completed':
        this.onItemCompleted(params as ItemCompletedNotification);
        break;
      case 'item/reasoning/summaryTextDelta':
        this.onReasoningSummaryDelta(params as ReasoningSummaryTextDeltaNotification);
        break;
      case 'item/reasoning/textDelta':
        this.onReasoningTextDelta(params as ReasoningTextDeltaNotification);
        break;
      case 'item/reasoning/summaryPartAdded':
        break;
      case 'item/plan/delta':
        this.onPlanDelta(params as PlanDeltaNotification);
        break;
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.onOutputDelta(params as { itemId: string; delta: string });
        break;
      case 'item/fileChange/patchUpdated':
        this.onFileChangePatchUpdated(params as FileChangePatchUpdatedNotification);
        break;
      case 'rawResponseItem/completed':
        this.onRawResponseItemCompleted(params);
        break;
      case 'event_msg':
        this.onEventMsg(params);
        break;
      case 'thread/tokenUsage/updated':
        this.onTokenUsageUpdated(params as TokenUsageUpdatedNotification);
        break;
      case 'turn/plan/updated':
        this.onPlanUpdated(params as TurnPlanUpdatedNotification);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params as TurnCompletedNotification);
        break;
      case 'error':
        this.onError(params as ErrorNotification);
        break;
      default:
        break;
    }
  }

  private onAgentMessageDelta(params: AgentMessageDeltaNotification): void {
    this.agentMessageDeltaIds.add(params.itemId);
    this.appendAssistantText(params.delta, params.itemId);
    this.emit({ type: 'text', content: params.delta });
  }

  private onReasoningSummaryDelta(params: ReasoningSummaryTextDeltaNotification): void {
    this.emit({ type: 'thinking', content: params.delta });
  }

  private onReasoningTextDelta(params: ReasoningTextDeltaNotification): void {
    this.emit({ type: 'thinking', content: params.delta });
  }

  private onPlanDelta(params: PlanDeltaNotification): void {
    this.sawPlanDelta = true;
    this.emit({ type: 'text', content: params.delta });
  }

  private onItemStarted(params: ItemStartedNotification): void {
    const item = params.item;
    const itemId = getItemId(item);
    if (itemId && this.rawStartedCallIds.has(itemId)) {
      return;
    }

    switch (item.type) {
      case 'userMessage':
        this.emitUserMessageBoundary(item);
        break;

      case 'agentMessage':
        this.emitAgentMessageBoundary(item);
        break;

      case 'reasoning':
        break;

      case 'commandExecution':
        if (this.claimRawCommandWrapper(item)) {
          this.suppressedSemanticCommandIds.add(item.id);
        } else {
          this.emitToolUseFromCommand(item);
        }
        break;

      case 'fileChange':
        this.emitToolUseFromFileChange(item);
        break;

      case 'imageView':
        if (this.claimRawImageWrapper(item)) {
          this.suppressedSemanticImageIds.add(item.id);
        } else {
          this.emitToolUseFromImageView(item);
        }
        break;

      case 'webSearch':
        this.emitToolUseFromWebSearch(item);
        break;

      case 'collabAgentToolCall':
        this.emitToolUseFromCollabAgent(item);
        break;

      case 'mcpToolCall':
        this.emitToolUseFromMcp(item);
        break;

      case 'dynamicToolCall':
        this.emitToolUseFromDynamic(item);
        break;

      default:
        break;
    }
  }

  private onItemCompleted(params: ItemCompletedNotification): void {
    const item = params.item;
    const itemId = getItemId(item);
    const rawResult = itemId ? this.consumeRawToolOutput(itemId) : undefined;

    switch (item.type) {
      case 'userMessage':
        if (!this.startedUserMessageIds.has(item.id)) {
          this.emitUserMessageBoundary(item);
        }
        break;

      case 'agentMessage':
        this.completeAgentMessage(item);
        break;

      case 'commandExecution':
        if (this.suppressedSemanticCommandIds.delete(item.id)) {
          break;
        }
        this.emitToolResultFromCommand(item, rawResult);
        break;

      case 'fileChange':
        this.emitToolUseFromFileChange(item);
        this.emitToolResultFromFileChange(item);
        break;

      case 'imageView':
        if (
          this.suppressedSemanticImageIds.delete(item.id)
          || this.claimRawImageWrapper(item)
        ) {
          break;
        }
        this.emitToolResultFromImageView(item);
        break;

      case 'webSearch':
        this.emitToolResultFromWebSearch(item);
        break;

      case 'collabAgentToolCall':
        this.emitToolResultFromCollabAgent(item);
        break;

      case 'mcpToolCall':
        this.emitToolResultFromMcp(item);
        break;

      case 'dynamicToolCall':
        this.emitToolResultFromDynamic(item);
        break;

      case 'contextCompaction':
        this.emitContextCompactionBoundary(item);
        break;

      default:
        if (itemId && rawResult) {
          this.emit({ type: 'tool_result', id: itemId, ...rawResult });
        }
        break;
    }
  }

  private onRawResponseItemCompleted(params: unknown): void {
    const item = asRecord(asRecord(params)?.item);
    const itemType = typeof item?.type === 'string' ? item.type : undefined;
    if (!item || !itemType) {
      return;
    }

    switch (itemType) {
      case 'function_call':
        this.handleRawFunctionCall(item);
        break;

      case 'custom_tool_call':
        this.handleRawCustomToolCall(item);
        break;

      case 'function_call_output':
      case 'custom_tool_call_output':
        this.handleRawToolOutput(item);
        break;

      case 'agentMessage':
      case 'message':
        this.emitMissingRawAgentMessageText(item);
        break;

      default:
        break;
    }
  }

  private onEventMsg(params: unknown): void {
    const payload = asRecord(params);
    if (!payload) {
      return;
    }

    const payloadType = typeof payload.type === 'string' ? payload.type : undefined;
    if (payloadType !== 'agent_message') {
      return;
    }

    const text = firstString(payload.text, payload.message);
    this.emitMissingAssistantTurnText(text);
  }

  private handleRawFunctionCall(item: Record<string, unknown>): void {
    const rawName = firstString(item.name, item.type);
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }

    const rawArguments = parseRawArguments(item);
    if (rawName === 'wait') {
      const cellId = readCodexExecCellIdArgument(rawArguments);
      const commandCallId = cellId
        ? this.wrappedCommandCallIdsByCellId.get(cellId)
        : undefined;
      if (cellId && commandCallId) {
        this.wrappedWaitCallsByCallId.set(callId, { commandCallId, cellId });
        return;
      }
    }

    if (rawName === 'write_stdin' && isSilentWriteStdinInput(rawArguments)) {
      this.suppressedRawCallIds.add(callId);
      return;
    }

    this.emitRawToolUse(callId, rawName, item, rawArguments);
  }

  private handleRawCustomToolCall(item: Record<string, unknown>): void {
    const rawName = firstString(item.name, item.type);
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }

    if (rawName === 'apply_patch') {
      const input = normalizeCodexToolInput(rawName, parseRawArguments(item));
      this.rememberFileChangeInput(callId, input);
      this.suppressedRawCallIds.add(callId);
      this.resetAssistantSegmentText();
      return;
    }

    if (rawName === 'exec') {
      const decodedCalls = decodeCodexExecEnvelope(parseRawArguments(item));
      if (decodedCalls && decodedCalls.length > 0) {
        this.emitRawExecEnvelope(callId, decodedCalls);
        return;
      }
    }

    // Raw custom output is terminal unless a canonical dynamic-tool completion also arrives.
    this.immediateRawOutputCallIds.add(callId);
    this.emitRawToolUse(callId, rawName, item);
  }

  private emitRawExecEnvelope(
    outerCallId: string,
    decodedCalls: Array<{ name: string; input: Record<string, unknown> }>,
  ): void {
    if (this.rawExecEnvelopeCallsByCallId.has(outerCallId)) {
      return;
    }

    const calls = decodedCalls.map((call, index): RawExecEnvelopeCall => ({
      id: decodedCalls.length === 1 ? outerCallId : `${outerCallId}:${index + 1}`,
      name: call.name,
      input: call.input,
    }));
    if (calls.every(call => this.rawStartedCallIds.has(call.id))) {
      return;
    }
    this.rawExecEnvelopeCallsByCallId.set(outerCallId, calls);
    this.resetAssistantSegmentText();

    for (const call of calls) {
      this.rawStartedCallIds.add(call.id);
      this.rawToolNamesByCallId.set(call.id, call.name);
      this.rawToolInputsByCallId.set(call.id, call.input);
      this.rememberRawExecEnvelopeCall(call);
      this.emit({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input,
      });
    }
  }

  private emitRawToolUse(
    callId: string,
    rawName: string,
    item: Record<string, unknown>,
    rawArguments?: Record<string, unknown>,
  ): void {
    const normalized = normalizeCodexToolCall(
      rawName,
      rawArguments ?? parseRawArguments(item),
    );

    if (this.rawStartedCallIds.has(callId)) {
      this.rawToolNamesByCallId.set(callId, normalized.name);
      this.rawToolInputsByCallId.set(callId, normalized.input);
      return;
    }

    this.rawStartedCallIds.add(callId);
    this.rawToolNamesByCallId.set(callId, normalized.name);
    this.rawToolInputsByCallId.set(callId, normalized.input);

    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: callId,
      name: normalized.name,
      input: normalized.input,
    });
  }

  private handleRawToolOutput(item: Record<string, unknown>): void {
    const callId = readRawCallId(item);
    if (!callId) {
      return;
    }

    const wrappedWaitCall = this.wrappedWaitCallsByCallId.get(callId);
    if (wrappedWaitCall) {
      this.wrappedWaitCallsByCallId.delete(callId);
      this.handleWrappedWaitOutput(wrappedWaitCall, item.output);
      return;
    }

    if (this.suppressedRawCallIds.delete(callId)) {
      return;
    }

    const execEnvelopeCalls = this.rawExecEnvelopeCallsByCallId.get(callId);
    if (execEnvelopeCalls) {
      this.handleRawExecEnvelopeOutput(callId, execEnvelopeCalls, item.output);
      return;
    }

    const normalizedName = this.rawToolNamesByCallId.get(callId);
    if (!normalizedName) {
      return;
    }

    const rawOutput = item.output;
    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    this.removePendingRawCommandWrapper(callId);

    const content = normalizeRawToolOutput(
      normalizedName,
      rawOutput,
      this.rawToolInputsByCallId.get(callId),
    );
    const result = {
      content,
      isError: isCodexToolOutputError(rawOutputText),
    };

    if (this.immediateRawOutputCallIds.delete(callId)) {
      const execCellId = normalizedName === 'Bash'
        ? extractCodexExecCellId(rawOutputText)
        : undefined;
      if (execCellId) {
        this.wrappedCommandCallIdsByCellId.set(execCellId, callId);
        this.appendWrappedCommandOutput(callId, content);
        return;
      }

      if (!this.emittedImmediateToolResultIds.has(callId)) {
        this.emittedImmediateToolResultIds.add(callId);
        this.emit({ type: 'tool_result', id: callId, ...result });
      }
      return;
    }

    this.rawToolOutputsByCallId.set(callId, result);
  }

  private handleRawExecEnvelopeOutput(
    outerCallId: string,
    calls: RawExecEnvelopeCall[],
    rawOutput: unknown,
  ): void {
    this.rawExecEnvelopeCallsByCallId.delete(outerCallId);
    for (const call of calls) {
      this.removePendingRawExecEnvelopeCall(call);
    }

    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    const outputParts = splitCodexExecEnvelopeOutput(rawOutput, calls.length);

    if (calls.length === 1) {
      const call = calls[0];
      if (!call) return;

      const outputValue = outputParts?.[0] ?? rawOutput;
      const content = normalizeRawToolOutput(call.name, outputValue, call.input);
      const execCellId = call.name === 'Bash'
        ? extractCodexExecCellId(rawOutputText)
        : undefined;
      if (execCellId) {
        this.wrappedCommandCallIdsByCellId.set(execCellId, call.id);
        this.appendWrappedCommandOutput(call.id, content);
        return;
      }

      this.emit({
        type: 'tool_result',
        id: call.id,
        content,
        isError: isCodexToolOutputError(rawOutputText),
      });
      return;
    }

    if (outputParts) {
      for (const [index, call] of calls.entries()) {
        const outputValue = outputParts[index] ?? '';
        const outputText = stringifyCodexToolOutput(outputValue);
        this.emit({
          type: 'tool_result',
          id: call.id,
          content: normalizeRawToolOutput(call.name, outputValue, call.input),
          isError: isCodexToolOutputError(outputText),
        });
      }
      return;
    }

    const isError = isCodexToolOutputError(rawOutputText);
    for (const [index, call] of calls.entries()) {
      const isLastCall = index === calls.length - 1;
      this.emit({
        type: 'tool_result',
        id: call.id,
        content: isLastCall
          ? normalizeRawToolOutput(call.name, rawOutput, call.input)
          : '',
        isError,
      });
    }
  }

  private handleWrappedWaitOutput(waitCall: WrappedWaitCall, rawOutput: unknown): void {
    const rawOutputText = stringifyCodexToolOutput(rawOutput);
    const content = normalizeRawToolOutput(
      'Bash',
      rawOutput,
      this.rawToolInputsByCallId.get(waitCall.commandCallId),
    );
    const nextCellId = extractCodexExecCellId(rawOutputText);

    if (nextCellId) {
      this.wrappedCommandCallIdsByCellId.delete(waitCall.cellId);
      this.wrappedCommandCallIdsByCellId.set(nextCellId, waitCall.commandCallId);
      this.appendWrappedCommandOutput(waitCall.commandCallId, content);
      return;
    }

    const previousOutput = this.wrappedCommandOutputByCallId.get(waitCall.commandCallId);
    const completeOutput = appendCodexCommandOutput(previousOutput, content);
    this.wrappedCommandOutputByCallId.delete(waitCall.commandCallId);
    this.wrappedCommandCallIdsByCellId.delete(waitCall.cellId);
    this.emit({
      type: 'tool_result',
      id: waitCall.commandCallId,
      content: completeOutput,
      isError: isCodexToolOutputError(rawOutputText),
    });
  }

  private appendWrappedCommandOutput(callId: string, content: string): void {
    if (!content) return;

    const previousOutput = this.wrappedCommandOutputByCallId.get(callId);
    const completeOutput = appendCodexCommandOutput(previousOutput, content);
    const delta = completeOutput.slice(previousOutput?.length ?? 0);
    this.wrappedCommandOutputByCallId.set(callId, completeOutput);
    if (delta) {
      this.emit({ type: 'tool_output', id: callId, content: delta });
    }
  }

  private rememberRawExecEnvelopeCall(call: RawExecEnvelopeCall): void {
    if (call.name === normalizeCodexToolName('exec_command')) {
      this.rememberRawCommandWrapper(call.id, call.input);
      return;
    }

    if (call.name === normalizeCodexToolName('view_image')) {
      const path = firstString(call.input.file_path, call.input.path);
      if (path) {
        this.pendingRawImageWrappers.push({ callId: call.id, path });
      }
    }
  }

  private removePendingRawExecEnvelopeCall(call: RawExecEnvelopeCall): void {
    if (call.name === normalizeCodexToolName('exec_command')) {
      this.removePendingRawCommandWrapper(call.id);
      return;
    }

    if (call.name === normalizeCodexToolName('view_image')) {
      this.pendingRawImageWrappers = this.pendingRawImageWrappers
        .filter(wrapper => wrapper.callId !== call.id);
    }
  }

  private rememberRawCommandWrapper(
    callId: string,
    input: Record<string, unknown>,
  ): void {
    const fingerprint = createCommandFingerprint(input);
    if (fingerprint) {
      queuePendingId(this.rawCommandWrapperIdsByFingerprint, fingerprint, callId);
    }
  }

  private claimRawCommandWrapper(item: CommandExecutionItem): boolean {
    // The outer raw exec item precedes its nested semantic command item on the wire.
    // Keep the raw card as the display owner and suppress the matching semantic lifecycle.
    const commandInputs = [
      normalizeCodexToolInput('command_execution', { command: item.command }),
      buildCommandInput(item),
    ];
    for (const input of commandInputs) {
      const fingerprint = createCommandFingerprint(input);
      if (
        fingerprint
        && takePendingId(this.rawCommandWrapperIdsByFingerprint, fingerprint) !== undefined
      ) {
        return true;
      }
    }

    const actionFingerprints = createCommandActionFingerprints(item);
    if (actionFingerprints.length < 2) {
      return false;
    }

    for (const rawFingerprint of this.rawCommandWrapperIdsByFingerprint.keys()) {
      if (
        containsCommandActionSequence(rawFingerprint, actionFingerprints)
        && takePendingId(this.rawCommandWrapperIdsByFingerprint, rawFingerprint) !== undefined
      ) {
        return true;
      }
    }
    return false;
  }

  private removePendingRawCommandWrapper(callId: string): void {
    const input = this.rawToolInputsByCallId.get(callId);
    const fingerprint = input ? createCommandFingerprint(input) : null;
    if (fingerprint) {
      removePendingId(this.rawCommandWrapperIdsByFingerprint, fingerprint, callId);
    }
  }

  private claimRawImageWrapper(item: ImageViewItem): boolean {
    const wrapperIndex = this.pendingRawImageWrappers.findIndex(wrapper => (
      areEquivalentToolPaths(wrapper.path, item.path)
    ));
    if (wrapperIndex === -1) {
      return false;
    }

    this.pendingRawImageWrappers.splice(wrapperIndex, 1);
    return true;
  }

  private emitMissingRawAgentMessageText(item: Record<string, unknown>): void {
    const text = item.type === 'message'
      ? readAssistantMessageText(item)
      : firstString(item.text, item.message);
    this.emitMissingAssistantSegmentText(text);
  }

  private emitMissingAssistantSegmentText(text: string, itemId?: string): void {
    this.claimAssistantSegment(itemId);
    const missingText = normalizeAgentMessageCompletionText(
      text,
      this.currentAssistantSegmentText,
    );
    if (text) {
      this.currentAssistantSegmentText = text;
    }
    if (!missingText) {
      return;
    }

    this.streamedAssistantTurnText += missingText;
    this.emit({ type: 'text', content: missingText });
  }

  private emitMissingAssistantTurnText(text: string): void {
    const missingText = normalizeAgentMessageCompletionText(
      text,
      this.streamedAssistantTurnText,
    );
    if (!missingText) {
      return;
    }

    this.streamedAssistantTurnText += missingText;
    this.currentAssistantSegmentText += missingText;
    this.emit({ type: 'text', content: missingText });
  }

  private consumeRawToolOutput(callId: string): RawToolResult | undefined {
    const result = this.rawToolOutputsByCallId.get(callId);
    this.rawToolOutputsByCallId.delete(callId);
    return result;
  }

  private flushPendingRawToolOutputs(): void {
    for (const [callId, result] of this.rawToolOutputsByCallId) {
      this.emit({ type: 'tool_result', id: callId, ...result });
    }
    this.rawToolOutputsByCallId.clear();
  }

  // -- commandExecution -------------------------------------------------------

  private emitToolUseFromCommand(item: CommandExecutionItem): void {
    const normalizedName = normalizeCodexToolName('command_execution');
    const input = buildCommandInput(item);

    this.resetAssistantSegmentText();
    this.emit({ type: 'tool_use', id: item.id, name: normalizedName, input });
  }

  private emitToolResultFromCommand(item: CommandExecutionItem, rawResult?: RawToolResult): void {
    const normalizedName = normalizeCodexToolName('command_execution');
    const output = item.aggregatedOutput ?? '';
    const content = rawResult?.content ?? normalizeCodexToolResult(normalizedName, output);
    const isError = item.exitCode !== null
      ? item.exitCode !== 0
      : rawResult?.isError ?? isCodexToolOutputError(output);

    this.emit({ type: 'tool_result', id: item.id, content, isError });
  }

  // -- fileChange -------------------------------------------------------------

  private emitToolUseFromFileChange(item: FileChangeItem): void {
    const input = this.rememberFileChangeInput(
      item.id,
      buildFileChangeInput(item.changes ?? []),
    );

    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: normalizeCodexToolName('file_change'),
      input,
    });
  }

  private emitToolResultFromFileChange(item: FileChangeItem): void {
    const input = this.rememberFileChangeInput(
      item.id,
      buildFileChangeInput(item.changes ?? []),
    );
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const paths = changes
      .map(change => formatFileChangeSummary(change))
      .filter(Boolean)
      .join(', ');
    this.emit({
      type: 'tool_result',
      id: item.id,
      content: paths || 'File change completed',
      isError: item.status === 'failed' || item.status === 'declined',
    });
  }

  private onFileChangePatchUpdated(params: FileChangePatchUpdatedNotification): void {
    const itemId = firstString(params.itemId);
    if (!itemId) {
      return;
    }

    const input = this.rememberFileChangeInput(
      itemId,
      buildFileChangeInput(params.changes ?? []),
    );

    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: itemId,
      name: normalizeCodexToolName('file_change'),
      input,
    });
  }

  private rememberFileChangeInput(
    itemId: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const previous = this.fileChangeInputsById.get(itemId);
    const merged = mergeApplyPatchInputs(previous, input);
    this.fileChangeInputsById.set(itemId, merged);
    return merged;
  }

  // -- imageView --------------------------------------------------------------

  private emitToolUseFromImageView(item: ImageViewItem): void {
    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: normalizeCodexToolName('view_image'),
      input: normalizeCodexToolInput('view_image', { path: item.path }),
    });
  }

  private emitToolResultFromImageView(item: ImageViewItem): void {
    this.emit({ type: 'tool_result', id: item.id, content: item.path, isError: false });
  }

  // -- webSearch --------------------------------------------------------------

  private emitToolUseFromWebSearch(item: WebSearchItem): void {
    if (this.seenWebSearchIds.has(item.id)) return;
    this.seenWebSearchIds.add(item.id);

    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: 'WebSearch',
      input: normalizeCodexToolInput('web_search', {
        query: item.query ?? '',
        queries: item.queries ?? [],
        url: item.url ?? '',
        pattern: item.pattern ?? '',
        action: item.action ?? {},
      }),
    });
  }

  private emitToolResultFromWebSearch(item: WebSearchItem): void {
    this.emit({
      type: 'tool_result',
      id: item.id,
      content: 'Search complete',
      isError: item.status === 'failed' || item.status === 'error',
    });
  }

  // -- collabAgentToolCall ----------------------------------------------------

  private emitToolUseFromCollabAgent(item: CollabAgentToolCallItem): void {
    const toolName = COLLAB_AGENT_TOOL_MAP[item.tool] ?? item.tool;
    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: toolName,
      input: item.arguments ?? {},
    });
  }

  private emitToolResultFromCollabAgent(item: CollabAgentToolCallItem): void {
    const resultText = item.result && typeof item.result === 'object'
      ? JSON.stringify(item.result)
      : item.status === 'completed' ? 'Completed' : item.status ?? 'Done';

    this.emit({
      type: 'tool_result',
      id: item.id,
      content: resultText,
      isError: item.status === 'failed' || item.status === 'error',
    });
  }

  // -- mcpToolCall ------------------------------------------------------------

  private emitToolUseFromMcp(item: McpToolCallItem): void {
    this.resetAssistantSegmentText();
    this.emit({
      type: 'tool_use',
      id: item.id,
      name: `mcp__${item.server}__${item.tool}`,
      input: item.arguments ?? {},
    });
  }

  private emitToolResultFromMcp(item: McpToolCallItem): void {
    let content = '';
    if (item.error) {
      content = item.error;
    } else if (item.result?.content) {
      content = item.result.content
        .map(c => c.text ?? '')
        .filter(Boolean)
        .join('\n');
    }
    if (!content) {
      content = item.status === 'completed' ? 'Completed' : 'Failed';
    }

    this.emit({
      type: 'tool_result',
      id: item.id,
      content,
      isError: item.status === 'failed' || item.status === 'error',
    });
  }

  // -- dynamicToolCall --------------------------------------------------------

  private emitToolUseFromDynamic(item: DynamicToolCallItem): void {
    this.emitRawToolUse(
      item.id,
      item.tool,
      {},
      asRecord(item.arguments) ?? {},
    );
  }

  private emitToolResultFromDynamic(item: DynamicToolCallItem): void {
    if (this.emittedImmediateToolResultIds.has(item.id)) return;
    this.emittedImmediateToolResultIds.add(item.id);

    const content = (item.contentItems ?? [])
      .map(contentItem => contentItem.type === 'inputText'
        ? contentItem.text
        : contentItem.imageUrl)
      .filter(Boolean)
      .join('\n');
    this.emit({
      type: 'tool_result',
      id: item.id,
      content: content || (item.success === false ? 'Failed' : 'Completed'),
      isError: item.success === false || item.status === 'failed',
    });
  }

  private emitContextCompactionBoundary(_item: ContextCompactionItem): void {
    this.emit({ type: 'context_compacted' });
  }

  private emitUserMessageBoundary(item: UserMessageItem): void {
    if (this.startedUserMessageIds.has(item.id)) {
      return;
    }

    const rawContent = this.extractUserMessageText(item.content);
    const visibleContent = extractCodexUserVisibleText(rawContent);
    this.startedUserMessageIds.add(item.id);

    if (visibleContent === null && rawContent.trim()) {
      return;
    }

    this.emit({
      type: 'user_message_start',
      itemId: item.id,
      content: visibleContent ?? rawContent,
    });
  }

  private emitAgentMessageBoundary(item: AgentMessageItem): void {
    if (this.startedAgentMessageIds.has(item.id)) {
      return;
    }

    this.startedAgentMessageIds.add(item.id);
    this.claimAssistantSegment(item.id);
    this.emit({ type: 'assistant_message_start', itemId: item.id });
  }

  private completeAgentMessage(item: AgentMessageItem): void {
    if (!this.startedAgentMessageIds.has(item.id)) {
      this.emitAgentMessageBoundary(item);
    }

    if (this.agentMessageDeltaIds.has(item.id) || !item.text) {
      return;
    }

    this.emitMissingAssistantSegmentText(item.text, item.id);
  }

  private extractUserMessageText(content: UserInput[]): string {
    return joinCodexUserTextParts(
      content.map((part) => (part.type === 'text' ? part.text : '')),
      '\n\n',
    );
  }

  // -- turn/plan/updated (update_plan) ----------------------------------------

  private onPlanUpdated(params: TurnPlanUpdatedNotification): void {
    this.planUpdateCounter += 1;
    const syntheticId = `plan-update-${params.turnId ?? this.planUpdateCounter}`;
    const PLAN_STATUS_MAP: Record<string, string> = {
      inProgress: 'in_progress',
      in_progress: 'in_progress',
    };

    const todos = params.plan.map(item => ({
      id: '',
      content: item.step,
      activeForm: item.step,
      status: PLAN_STATUS_MAP[item.status] ?? item.status,
    }));

    this.resetAssistantSegmentText();
    this.emit({ type: 'tool_use', id: syntheticId, name: 'TodoWrite', input: { todos } });
    this.emit({ type: 'tool_result', id: syntheticId, content: 'Plan updated', isError: false });
  }

  // -- outputDelta (commandExecution + fileChange) ----------------------------

  private onOutputDelta(params: { itemId: string; delta: string }): void {
    if (this.suppressedSemanticCommandIds.has(params.itemId)) {
      return;
    }
    this.emit({ type: 'tool_output', id: params.itemId, content: params.delta });
  }

  // -- tokenUsage / turnCompleted / error -------------------------------------

  private onTokenUsageUpdated(params: TokenUsageUpdatedNotification): void {
    const last = params.tokenUsage.last;
    const contextTokens = last.inputTokens;
    const contextWindow = params.tokenUsage.modelContextWindow;

    const usage: UsageInfo = {
      inputTokens: last.inputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: last.cachedInputTokens,
      contextWindow,
      contextWindowIsAuthoritative: contextWindow > 0,
      contextTokens,
      percentage: contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100))) : 0,
    };

    this.emit({ type: 'usage', usage, sessionId: params.threadId });
  }

  private onTurnCompleted(params: TurnCompletedNotification): void {
    const turn = params.turn;

    if (turn.status === 'failed' && turn.error) {
      this.emit({ type: 'error', content: turn.error.message });
    }

    if (turn.status === 'completed') {
      this.onTurnMetadata?.({
        assistantMessageId: turn.id,
        ...(this.isPlanTurn && this.sawPlanDelta ? { planCompleted: true } : {}),
      });
    }

    this.flushPendingRawToolOutputs();
    this.emit({ type: 'done' });
  }

  private onError(params: ErrorNotification): void {
    if (params.willRetry) return;
    this.emit({ type: 'error', content: params.error.message });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function buildCommandInput(item: CommandExecutionItem): Record<string, unknown> {
  const rawAction = item.commandActions?.[0]?.command ?? item.command;
  return normalizeCodexToolInput('command_execution', { command: rawAction });
}

function createCommandFingerprint(input: Record<string, unknown>): string | null {
  const command = normalizeShellCommandForFingerprint(firstString(input.command));
  return command ? command : null;
}

function createCommandActionFingerprints(item: CommandExecutionItem): string[] {
  return (item.commandActions ?? [])
    .map(action => normalizeShellCommandForFingerprint(firstString(action.command)))
    .filter(Boolean);
}

function containsCommandActionSequence(
  commandFingerprint: string,
  actionFingerprints: readonly string[],
): boolean {
  let searchStart = 0;

  for (const actionFingerprint of actionFingerprints) {
    const matchIndex = findCommandFingerprintSegment(
      commandFingerprint,
      actionFingerprint,
      searchStart,
    );
    if (matchIndex === -1) {
      return false;
    }
    searchStart = matchIndex + actionFingerprint.length;
  }

  return true;
}

function findCommandFingerprintSegment(
  commandFingerprint: string,
  actionFingerprint: string,
  startIndex: number,
): number {
  let matchIndex = commandFingerprint.indexOf(actionFingerprint, startIndex);

  while (matchIndex !== -1) {
    const endIndex = matchIndex + actionFingerprint.length;
    if (
      isShellCommandBoundary(commandFingerprint, matchIndex - 1)
      && isShellCommandBoundary(commandFingerprint, endIndex)
    ) {
      return matchIndex;
    }
    matchIndex = commandFingerprint.indexOf(actionFingerprint, matchIndex + 1);
  }

  return -1;
}

function isShellCommandBoundary(command: string, index: number): boolean {
  if (index < 0 || index >= command.length) {
    return true;
  }
  return /[\s;&|()]/.test(command[index] ?? '');
}

function normalizeShellCommandForFingerprint(command: string): string {
  let normalized = '';

  for (let index = 0; index < command.length; index += 1) {
    const quote = command[index];
    if (quote !== "'" && quote !== '"') {
      normalized += quote;
      continue;
    }

    const segment = readShellQuotedSegment(command, index, quote);
    if (!segment) {
      normalized += quote;
      continue;
    }

    const literal = quote === "'"
      ? segment.content
      : decodeStaticDoubleQuotedShellValue(segment.content);
    normalized += literal === null
      ? command.slice(index, segment.endIndex + 1)
      : formatShellLiteralFingerprint(literal);
    index = segment.endIndex;
  }

  return normalized.trim();
}

function readShellQuotedSegment(
  source: string,
  startIndex: number,
  quote: "'" | '"',
): { content: string; endIndex: number } | null {
  let content = '';

  for (let index = startIndex + 1; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quote === '"' && char === '\\') {
      const next = source[index + 1];
      if (next === undefined) return null;
      content += char + next;
      index += 1;
      continue;
    }
    if (char === quote) {
      return { content, endIndex: index };
    }
    content += char;
  }

  return null;
}

function decodeStaticDoubleQuotedShellValue(value: string): string | null {
  let decoded = '';

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (char === '$' || char === '`') {
      return null;
    }
    if (char !== '\\') {
      decoded += char;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) return null;
    if (next === '\n') {
      index += 1;
      continue;
    }
    if (next === '$' || next === '`' || next === '"' || next === '\\') {
      decoded += next;
      index += 1;
      continue;
    }
    decoded += `\\${next}`;
    index += 1;
  }

  return decoded;
}

function formatShellLiteralFingerprint(value: string): string {
  return /^[\p{L}\p{N}_./:@%+,=-]+$/u.test(value)
    ? value
    : JSON.stringify(value);
}

function areEquivalentToolPaths(left: string, right: string): boolean {
  const normalizedLeft = normalizeToolPath(left);
  const normalizedRight = normalizeToolPath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (isAbsoluteToolPath(normalizedLeft) && isAbsoluteToolPath(normalizedRight)) {
    return false;
  }

  const relativeLeft = normalizedLeft.replace(/^\/+/, '');
  const relativeRight = normalizedRight.replace(/^\/+/, '');
  return normalizedLeft.endsWith(`/${relativeRight}`)
    || normalizedRight.endsWith(`/${relativeLeft}`);
}

function normalizeToolPath(value: string): string {
  const withForwardSlashes = value.trim().replace(/\\/g, '/');
  const isAbsolute = withForwardSlashes.startsWith('/');
  const segments = withForwardSlashes
    .split('/')
    .filter(segment => segment && segment !== '.');
  return `${isAbsolute ? '/' : ''}${segments.join('/')}`;
}

function isAbsoluteToolPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function queuePendingId(
  pendingIds: Map<string, string[]>,
  fingerprint: string,
  id: string,
): void {
  const ids = pendingIds.get(fingerprint);
  if (ids) {
    ids.push(id);
    return;
  }
  pendingIds.set(fingerprint, [id]);
}

function takePendingId(
  pendingIds: Map<string, string[]>,
  fingerprint: string,
): string | undefined {
  const ids = pendingIds.get(fingerprint);
  const id = ids?.shift();
  if (ids?.length === 0) {
    pendingIds.delete(fingerprint);
  }
  return id;
}

function removePendingId(
  pendingIds: Map<string, string[]>,
  fingerprint: string,
  id: string,
): void {
  const ids = pendingIds.get(fingerprint);
  if (!ids) {
    return;
  }

  const remainingIds = ids.filter(pendingId => pendingId !== id);
  if (remainingIds.length > 0) {
    pendingIds.set(fingerprint, remainingIds);
    return;
  }
  pendingIds.delete(fingerprint);
}

function getItemId(item: { id?: string } | Record<string, unknown>): string | undefined {
  return typeof item.id === 'string' ? item.id : undefined;
}

function readRawCallId(item: Record<string, unknown>): string {
  return firstString(item.call_id, item.id);
}

function parseRawArguments(item: Record<string, unknown>): Record<string, unknown> {
  const rawArgs = typeof item.arguments === 'string'
    ? item.arguments
    : typeof item.input === 'string'
      ? item.input
      : undefined;
  return parseCodexArguments(rawArgs);
}

function isSilentWriteStdinInput(input: Record<string, unknown>): boolean {
  return typeof input.chars !== 'string' || input.chars.length === 0;
}

function normalizeRawToolOutput(
  normalizedName: string,
  rawOutput: unknown,
  input?: Record<string, unknown>,
): string {
  if (Array.isArray(rawOutput) && normalizedName === 'Read') {
    const filePath = firstString(input?.file_path, input?.path);
    if (filePath) {
      return filePath;
    }
  }

  return normalizeCodexToolResult(normalizedName, stringifyCodexToolOutput(rawOutput));
}

function buildFileChangeInput(changes: unknown): Record<string, unknown> {
  return { changes: normalizeFileChanges(changes) };
}

function mergeApplyPatchInputs(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) {
    return next;
  }

  const patch = typeof next.patch === 'string'
    ? next.patch
    : typeof previous.patch === 'string'
      ? previous.patch
      : undefined;
  const changes = mergeFileChanges(previous.changes, next.changes);
  return {
    ...previous,
    ...next,
    ...(patch ? { patch } : {}),
    ...(changes.length > 0 ? { changes } : {}),
  };
}

function normalizeFileChanges(changes: unknown): Record<string, unknown>[] {
  if (!Array.isArray(changes)) {
    return [];
  }

  return changes
    .map(normalizeFileChange)
    .filter((change): change is Record<string, unknown> => change !== null);
}

function normalizeFileChange(change: unknown): Record<string, unknown> | null {
  const record = asRecord(change);
  const path = firstString(record?.path);
  if (!record || !path) {
    return null;
  }

  const kindInfo = normalizeFileChangeKind(record.kind ?? record.type);
  const diff = firstString(record.diff);
  return {
    ...record,
    path,
    kind: kindInfo.kind,
    type: kindInfo.kind,
    ...(kindInfo.movePath ? { movePath: kindInfo.movePath } : {}),
    ...(diff ? { diff } : {}),
  };
}

function normalizeFileChangeKind(value: unknown): { kind: string; movePath?: string } {
  if (typeof value === 'string' && value) {
    return { kind: value };
  }

  const record = asRecord(value);
  const kind = firstString(record?.type) || 'change';
  const movePath = firstString(record?.move_path);
  return {
    kind,
    ...(movePath ? { movePath } : {}),
  };
}

function mergeFileChanges(previous: unknown, next: unknown): Record<string, unknown>[] {
  const previousChanges = normalizeFileChanges(previous);
  const nextChanges = normalizeFileChanges(next);
  if (previousChanges.length === 0) return nextChanges;
  if (nextChanges.length === 0) return previousChanges;

  const merged = new Map<string, Record<string, unknown>>();
  for (const change of previousChanges) {
    merged.set(fileChangeKey(change), change);
  }
  for (const change of nextChanges) {
    const key = fileChangeKey(change);
    const previousChange = merged.get(key);
    merged.set(key, previousChange ? mergeFileChange(previousChange, change) : change);
  }
  return [...merged.values()];
}

function mergeFileChange(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...previous,
    ...next,
    ...(typeof next.diff === 'string'
      ? { diff: next.diff }
      : typeof previous.diff === 'string'
        ? { diff: previous.diff }
        : {}),
  };
}

function fileChangeKey(change: Record<string, unknown>): string {
  return `${firstString(change.path)}\0${firstString(change.movePath)}`;
}

function formatFileChangeSummary(change: unknown): string {
  const record = asRecord(change);
  const path = firstString(record?.path);
  if (!record || !path) {
    return '';
  }

  const kind = firstString(record.kind, record.type) || 'change';
  return `${kind}: ${path}`;
}

function readContentText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((entry) => firstString(asRecord(entry)?.text))
    .join('');
}

function readAssistantMessageText(item: Record<string, unknown>): string {
  if (firstString(item.role) !== 'assistant') {
    return '';
  }

  return readContentText(item.content);
}

function normalizeAgentMessageCompletionText(
  text: string,
  streamedAssistantText: string,
): string {
  if (!text) {
    return '';
  }
  if (!streamedAssistantText) {
    return text;
  }
  if (text.startsWith(streamedAssistantText)) {
    return text.slice(streamedAssistantText.length);
  }
  return text;
}
