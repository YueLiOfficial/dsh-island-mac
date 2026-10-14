#!/usr/bin/env node
/**
 * Fake island helper — a Node stand-in for the Swift native helper.
 *
 * It implements exactly the socket contract the plugin's client expects:
 * bind + listen on a Unix socket, read NDJSON frames, print what it receives,
 * and stay in `accept` when the client disconnects (the real helper must
 * survive plugin restarts the same way).
 *
 * It exists so the whole plugin can be exercised end to end — spawn, connect,
 * push, and teardown — before the Swift layer is buildable, and it remains
 * useful afterwards as a protocol integration double.
 *
 * Diagnostics go to STDERR, not stdout: the plugin deliberately spawns the
 * helper with stdout ignored (an undrained stdout pipe wedges a chatty
 * helper), so anything written to stdout would be discarded.
 *
 * Usage: node fake-helper.mjs <socket-path>
 */

import { createServer } from 'node:net'
import { chmodSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const socketPath = process.argv[2]
if (!socketPath) {
  console.error('fake-helper: missing socket path argument')
  process.exit(2)
}

mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
try {
  chmodSync(dirname(socketPath), 0o700)
} catch {
  // Best effort: the directory may be owned by someone else in tests.
}

// Unconditionally clear a stale socket before binding. Without this a crashed
// previous run would make every subsequent bind fail.
if (existsSync(socketPath)) {
  try {
    unlinkSync(socketPath)
  } catch {
    // Another helper may be actively serving; bind will fail loudly below.
  }
}

let current = null

function handleConnection(socket) {
  // Single-client semantics: a new client replaces the old one, which is what
  // tolerates a plugin restart without the helper exiting.
  if (current && current !== socket) {
    try {
      current.destroy()
    } catch {
      /* already gone */
    }
  }
  current = socket

  let buffer = ''

  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let newlineAt
    while ((newlineAt = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineAt).trim()
      buffer = buffer.slice(newlineAt + 1)
      if (line.length === 0) continue
      try {
        const msg = JSON.parse(line)
        if (msg && msg.type === 'progress') {
          process.stderr.write(`progress ${Math.round(msg.percent * 100)}% ${msg.mode}\n`)
        } else if (msg && msg.type === 'hello') {
          process.stderr.write(`hello v${msg.version}\n`)
        } else if (msg && msg.type === 'done') {
          process.stderr.write(`done ok=${msg.ok} reason=${msg.reason}\n`)
        } else if (msg && msg.type === 'bye') {
          process.stderr.write('bye\n')
        } else {
          process.stderr.write(`unknown ${line}\n`)
        }
      } catch {
        process.stderr.write(`fake-helper: malformed frame dropped\n`)
      }
    }
  })

  const release = () => {
    if (current === socket) current = null
  }
  socket.on('error', release)
  socket.on('close', release)
}

const server = createServer(handleConnection)

server.on('error', (err) => {
  process.stderr.write(`fake-helper: server error ${err.message}\n`)
  process.exit(1)
})

server.listen(socketPath, () => {
  try {
    chmodSync(socketPath, 0o600)
  } catch {
    /* best effort */
  }
  process.stderr.write(`listening ${socketPath}\n`)
})

function shutdown() {
  try {
    server.close()
  } catch {
    /* already closed */
  }
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      /* best effort */
    }
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
