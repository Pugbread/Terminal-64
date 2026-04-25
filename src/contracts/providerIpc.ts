export interface CreateCodexRequest {
  session_id: string;
  cwd: string;
  prompt: string;
  sandbox_mode?: string;
  approval_policy?: string;
  model?: string;
  effort?: string;
  full_auto?: boolean;
  yolo?: boolean;
  skip_git_repo_check?: boolean;
  mcp_env?: Record<string, string>;
}

export interface SendCodexPromptRequest {
  session_id: string;
  thread_id?: string;
  cwd: string;
  prompt: string;
  sandbox_mode?: string;
  approval_policy?: string;
  model?: string;
  effort?: string;
  full_auto?: boolean;
  yolo?: boolean;
  skip_git_repo_check?: boolean;
  mcp_env?: Record<string, string>;
}
