/** 统一的业务错误：code 供 MCP/HTTP/CLI 输出，message 面向用户（简体中文）。 */
export class C2CError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(message);
    this.name = "C2CError";
  }
}
