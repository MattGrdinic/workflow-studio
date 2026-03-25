// ============================================
// Workflow Studio Types (self-contained)
// ============================================

export type NodeValue = string | number | boolean | null | NodeValue[] | { [key: string]: NodeValue };

export interface WorkflowNode {
  id: string;
  type: string;
  label?: string;
  position?: { x: number; y: number };
  config?: Record<string, NodeValue>;
  inputs?: Record<string, NodeValue>;
}

export interface WorkflowEdge {
  id?: string;
  from: string;
  to: string;
}

export interface WorkflowGraph {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  nodes: WorkflowNode[];
  edges?: WorkflowEdge[];
  variables?: Record<string, NodeValue>;
}

export interface WorkflowExecutionContext {
  cwd: string;
  variables?: Record<string, NodeValue>;
}

export interface NodeExecutionContext {
  graph: WorkflowGraph;
  node: WorkflowNode;
  resolvedConfig: Record<string, NodeValue>;
  resolvedInputs: Record<string, NodeValue>;
  previousResults: Record<string, NodeExecutionResult>;
  runContext: WorkflowExecutionContext;
}

export interface NodeExecutionResult {
  nodeId: string;
  nodeType: string;
  success: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output?: NodeValue | Record<string, unknown>;
  error?: string;
}

export interface WorkflowExecutionResult {
  graphId?: string;
  graphName?: string;
  success: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  order: string[];
  nodeResults: Record<string, NodeExecutionResult>;
  errors: string[];
}

export interface WorkflowNodeDefinition {
  type: string;
  title: string;
  description: string;
  useCase?: string;
  category: 'jira' | 'ai' | 'image' | 'io' | 'transform';
  configSchema: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required?: boolean;
    placeholder?: string;
    defaultValue?: NodeValue;
    multiline?: boolean;
    hint?: string;
    options?: string[];
  }>;
  outputSchema?: Array<{
    key: string;
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
  }>;
}

export type NodeExecutor = (ctx: NodeExecutionContext) => Promise<NodeValue | Record<string, unknown>>;

export interface ChatMessage {
  role: 'assistant' | 'user' | 'system';
  content: string;
  timestamp: string;
}

export interface ChatResolution {
  transcript: ChatMessage[];
  action: 'apply' | 'discard';
}

export interface ChatSessionState {
  sessionId: string;
  nodeId: string;
  messages: ChatMessage[];
  resolve: (result: ChatResolution) => void;
  systemPrompt: string;
  maxTurns: number;
  turnCount: number;
  onProgress?: WorkflowProgressCallback;
}

export interface WorkflowProgressEvent {
  type: 'node-start' | 'node-complete' | 'node-error' | 'workflow-complete' | 'node-pause' | 'chat-message';
  nodeId?: string;
  nodeType?: string;
  result?: NodeExecutionResult;
  workflowResult?: WorkflowExecutionResult;
  chatMessage?: ChatMessage;
  chatSessionId?: string;
  upstreamContent?: string;
}

export type WorkflowProgressCallback = (event: WorkflowProgressEvent) => void;

export interface WorkflowRunOptions {
  onProgress?: WorkflowProgressCallback;
  signal?: AbortSignal;
}

// ============================================
// Model type (from HeadlessWorkerExecutor)
// ============================================

export type ModelType = 'sonnet' | 'opus' | 'haiku';
