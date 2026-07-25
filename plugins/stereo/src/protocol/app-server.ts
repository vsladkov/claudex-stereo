import type {
  ClientInfo,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  ServerNotification,
} from '../../../../.generated/app-server-types/index.js';
import type {
  ConfigReadParams,
  ConfigReadResponse,
  ExternalAgentConfigImportParams,
  ExternalAgentConfigImportResponse,
  GetAccountParams,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  MigrationDetails,
  RateLimitSnapshot,
  ReviewDelivery,
  ReviewStartParams,
  ReviewStartResponse,
  ReviewTarget,
  SandboxPolicy,
  Thread,
  ThreadItem,
  ThreadListParams,
  ThreadListResponse,
  ThreadResumeParams as RawThreadResumeParams,
  ThreadResumeResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStartParams as RawThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  Turn,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from '../../../../.generated/app-server-types/v2/index.js';

export type {
  ClientInfo,
  ConfigReadResponse,
  ExternalAgentConfigImportParams,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  InitializeCapabilities,
  InitializeParams,
  InitializeResponse,
  MigrationDetails,
  RateLimitSnapshot,
  ReviewDelivery,
  ReviewStartResponse,
  ReviewTarget,
  SandboxPolicy,
  Thread,
  ThreadItem,
  ThreadListParams,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  Turn,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
};

export type ThreadStartParams = Omit<RawThreadStartParams, 'persistExtendedHistory'>;
export type ThreadResumeParams = Omit<RawThreadResumeParams, 'persistExtendedHistory'>;

export interface CodexAppServerClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities;
  brokerEndpoint?: string;
  disableBroker?: boolean;
  reuseExistingBroker?: boolean;
}

export interface AppServerMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'account/read': { params: GetAccountParams; result: GetAccountResponse };
  'account/rateLimits/read': { params: undefined; result: GetAccountRateLimitsResponse };
  'config/read': { params: ConfigReadParams; result: ConfigReadResponse };
  'externalAgentConfig/import': {
    params: ExternalAgentConfigImportParams;
    result: ExternalAgentConfigImportResponse;
  };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'thread/name/set': { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  'thread/list': { params: ThreadListParams; result: ThreadListResponse };
  'review/start': { params: ReviewStartParams; result: ReviewStartResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export type AppServerMethod = keyof AppServerMethodMap;
export type AppServerRequestParams<M extends AppServerMethod> = AppServerMethodMap[M]['params'];
export type AppServerResponse<M extends AppServerMethod> = AppServerMethodMap[M]['result'];
export type AppServerNotification = ServerNotification;
export type AppServerNotificationHandler = (message: AppServerNotification) => void;
