export interface Ok<T> {
  ok: true
  status: number
  data: T
}

export interface Err {
  ok: false
  status: number
  code: string
  message: string
}

export type Result<T> = Ok<T> | Err

export function ok<T>(data: T, status = 200): Ok<T> {
  return { ok: true, status, data }
}

export function err(status: number, code: string, message: string): Err {
  return { ok: false, status, code, message }
}
