/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 可选的 API 访问令牌，附带到所有请求的 X-API-Token 头（与后端 SANGFOR_API_TOKEN 一致）。 */
  readonly VITE_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
