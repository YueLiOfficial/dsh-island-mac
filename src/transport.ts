import { createConnection, type Socket } from 'node:net'

/**
 * A framed writer for one connection.
 *
 * `send` never throws: a dead socket must be observable through `alive` so the
 * caller can reconnect, not an exception that unwinds an event handler and
 * takes the harness down with it.
 */
export interface LineSender {
  send(line: string): void
  readonly alive: boolean
  close(): void
}

export interface ConnectOptions {
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Opens a connection to the helper's socket, resolving once the connection is
 * established.
 *
 * Rejects on `error` or timeout so the caller's retry loop can try again; the
 * helper is the server here, so a connect can legitimately fail while it is
 * still binding.
 */
export function connectLineSender(socketPath: string, opts: ConnectOptions): Promise<LineSender> {
  return new Promise<LineSender>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('connect aborted'))
      return
    }

    let settled = false
    let alive = true
    const socket: Socket = createConnection(socketPath)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // An unhandled 'error' would crash the process, so keep a listener
      // attached even while abandoning this attempt.
      socket.once('error', () => undefined)
      socket.destroy()
      reject(new Error(`connect to ${socketPath} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.once('error', () => undefined)
      socket.destroy()
      reject(new Error('connect aborted'))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    socket.once('connect', () => {
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)

      // A socket error after connecting must only flip `alive`. Without these
      // listeners Node would raise an unhandled 'error' event and terminate
      // the DSH process when the helper dies.
      socket.on('error', () => {
        alive = false
      })
      socket.on('close', () => {
        alive = false
      })

      const sender: LineSender = {
        send(line: string): void {
          if (!alive || socket.destroyed || !socket.writable) {
            alive = false
            return
          }
          try {
            socket.write(`${line}\n`)
          } catch {
            alive = false
          }
        },
        get alive(): boolean {
          return alive
        },
        close(): void {
          alive = false
          socket.removeAllListeners('error')
          socket.on('error', () => undefined)
          socket.destroy()
        },
      }

      resolve(sender)
    })

    socket.once('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
  })
}
