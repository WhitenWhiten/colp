import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as REKeyboardEvent,
} from 'react'

type Line =
  | { id: string; kind: 'out' | 'err' | 'sys'; text: string }
  | { id: string; kind: 'cmd'; prompt: string; text: string }

type Session = {
  user: string
  host: string
  port: number
  cwd: string
  connected: boolean
}

type Props = {
  resourceId: string
  defaultHost?: string
  defaultUser?: string
}

const BOOT: string[] = [
  'OpenSSH_9.6p1, LibreSSL 3.8.2',
  'demo mode — no network packets leave this browser',
  '',
]

function newId() {
  return `ln-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function promptOf(s: Session) {
  const short = s.cwd === '/home/' + s.user ? '~' : s.cwd
  return `${s.user}@${s.host}:${short}$`
}

function fakeExec(raw: string, session: Session): { lines: string[]; session: Session; clear?: boolean } {
  const input = raw.trim()
  if (!input) return { lines: [], session }

  const [cmd, ...rest] = input.split(/\s+/)
  const arg = rest.join(' ')
  const next = { ...session }

  switch (cmd) {
    case 'help':
    case '?':
      return {
        lines: [
          'Know-N SSH demo — local simulation only.',
          '  help, clear, pwd, whoami, hostname, uname -a',
          '  ls, ls -la, cd <path>, cat <file>',
          '  echo <text>, date, uptime, df -h, free -h',
          '  history, ssh user@host, exit / logout',
        ],
        session: next,
      }
    case 'clear':
    case 'cls':
      return { lines: [], session: next, clear: true }
    case 'pwd':
      return { lines: [session.cwd], session: next }
    case 'whoami':
      return { lines: [session.user], session: next }
    case 'hostname':
      return { lines: [session.host], session: next }
    case 'date':
      return { lines: [new Date().toString()], session: next }
    case 'echo':
      return { lines: [arg], session: next }
    case 'uname':
      return {
        lines: [
          rest.includes('-a') || rest[0] === '-a'
            ? `Linux ${session.host} 6.8.0-40-generic #40-Ubuntu SMP x86_64 GNU/Linux`
            : 'Linux',
        ],
        session: next,
      }
    case 'uptime':
      return {
        lines: [
          ` ${new Date().toTimeString().slice(0, 8)} up 14 days,  3:22,  2 users,  load average: 0.12, 0.08, 0.05`,
        ],
        session: next,
      }
    case 'df':
      return {
        lines: [
          'Filesystem      Size  Used Avail Use% Mounted on',
          '/dev/vda1        40G   18G   20G  48% /',
          'tmpfs           3.9G     0  3.9G   0% /dev/shm',
        ],
        session: next,
      }
    case 'free':
      return {
        lines: [
          '               total        used        free      shared  buff/cache   available',
          'Mem:         7961232     2144220     3120896      182304     2696116     5420188',
          'Swap:        2097148           0     2097148',
        ],
        session: next,
      }
    case 'ls': {
      const long = rest.includes('-l') || rest.includes('-la') || rest.includes('-al')
      if (long) {
        return {
          lines: [
            'total 48',
            'drwxr-xr-x  8 alex alex 4096 Mar 12 09:14 .',
            'drwxr-xr-x  3 root root 4096 Jan  2 11:01 ..',
            '-rw-------  1 alex alex  812 Mar 11 22:03 .bash_history',
            'drwx------  3 alex alex 4096 Feb 18 16:40 .ssh',
            'drwxr-xr-x  5 alex alex 4096 Mar 10 14:22 projects',
            'drwxr-xr-x  2 alex alex 4096 Mar  8 08:55 notes',
            '-rw-r--r--  1 alex alex  220 Jan  2 11:01 .bash_logout',
            '-rw-r--r--  1 alex alex 3771 Jan  2 11:01 .bashrc',
          ],
          session: next,
        }
      }
      return {
        lines: ['notes  projects  .ssh  .bashrc  README.md'],
        session: next,
      }
    }
    case 'cd': {
      if (!arg || arg === '~' || arg === `$HOME`) {
        next.cwd = `/home/${session.user}`
        return { lines: [], session: next }
      }
      if (arg === '..') {
        const parts = session.cwd.split('/').filter(Boolean)
        parts.pop()
        next.cwd = '/' + parts.join('/') || '/'
        return { lines: [], session: next }
      }
      if (arg === '/') {
        next.cwd = '/'
        return { lines: [], session: next }
      }
      if (arg.startsWith('/')) {
        next.cwd = arg.replace(/\/+$/, '') || '/'
        return { lines: [], session: next }
      }
      next.cwd = `${session.cwd.replace(/\/$/, '')}/${arg}`
      return { lines: [], session: next }
    }
    case 'cat': {
      if (!arg) return { lines: ['cat: missing file operand'], session: next }
      if (arg === 'README.md' || arg.endsWith('README.md')) {
        return {
          lines: [
            '# lab box',
            '',
            'This host is a Know-N dashboard SSH demo.',
            'Nothing is executed remotely.',
          ],
          session: next,
        }
      }
      if (arg.includes('id_rsa') || arg.includes('.pem')) {
        return { lines: [`cat: ${arg}: Permission denied`], session: next }
      }
      return { lines: [`cat: ${arg}: No such file or directory`], session: next }
    }
    case 'history':
      return {
        lines: ['  1  help', '  2  ls -la', '  3  cd projects', '  4  uname -a'],
        session: next,
      }
    case 'ssh': {
      if (!arg) {
        return { lines: ['usage: ssh user@host'], session: next }
      }
      const m = arg.match(/^(?:([a-zA-Z0-9._-]+)@)?([a-zA-Z0-9._-]+)(?::(\d+))?$/)
      if (!m) {
        return { lines: [`ssh: could not resolve hostname ${arg}`], session: next }
      }
      const user = m[1] || session.user
      const host = m[2] ?? arg
      const port = m[3] ? Number(m[3]) : 22
      next.user = user
      next.host = host
      next.port = port
      next.cwd = `/home/${user}`
      next.connected = true
      return {
        lines: [
          `Connecting to ${host} port ${port}…`,
          `Authenticated to ${host} ([203.0.113.14]:${port}).`,
          `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-40-generic x86_64)`,
          '',
          `Last login: ${new Date().toUTCString()} from 198.51.100.22`,
        ],
        session: next,
      }
    }
    case 'exit':
    case 'logout':
      return {
        lines: ['Connection to host closed. (demo — session stays open)'],
        session: next,
      }
    default:
      return {
        lines: [`bash: ${cmd}: command not found`],
        session: next,
      }
  }
}

export function SshTerminalWidget({
  resourceId,
  defaultHost = 'lab.known.dev',
  defaultUser = 'alex',
}: Props) {
  const inputId = useId()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [session, setSession] = useState<Session>(() => ({
    user: defaultUser,
    host: defaultHost,
    port: 22,
    cwd: `/home/${defaultUser}`,
    connected: true,
  }))
  const [lines, setLines] = useState<Line[]>(() =>
    BOOT.map((text) => ({ id: newId(), kind: text ? 'sys' : 'out', text: text || ' ' })),
  )
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lines, value, busy])

  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  const run = useCallback(
    (raw: string) => {
      const prompt = promptOf(session)
      const cmdLine: Line = { id: newId(), kind: 'cmd', prompt, text: raw }
      const result = fakeExec(raw, session)

      if (result.clear) {
        setLines([])
        setSession(result.session)
        return
      }

      setBusy(true)
      // Slight delay so it feels like a remote hop
      window.setTimeout(() => {
        const out: Line[] = result.lines.map((text) => ({
          id: newId(),
          kind: text.startsWith('bash:') || text.includes('Permission denied') || text.includes('No such')
            ? ('err' as const)
            : ('out' as const),
          text,
        }))
        setLines((prev) => [...prev, cmdLine, ...out])
        setSession(result.session)
        setBusy(false)
      }, raw.trim().startsWith('ssh') ? 420 : 80)

      if (raw.trim()) {
        setHistory((h) => (h[h.length - 1] === raw ? h : [...h, raw].slice(-80)))
      }
      setHistIdx(-1)
    },
    [session],
  )

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const raw = value
    setValue('')
    run(raw)
  }

  const onKeyDown = (e: REKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      setValue('')
      setLines((prev) => [
        ...prev,
        { id: newId(), kind: 'cmd', prompt: promptOf(session), text: value + '^C' },
      ])
      return
    }
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      setLines([])
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!history.length) return
      const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(next)
      setValue(history[next] ?? '')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx < 0) return
      const next = histIdx + 1
      if (next >= history.length) {
        setHistIdx(-1)
        setValue('')
      } else {
        setHistIdx(next)
        setValue(history[next] ?? '')
      }
    }
  }

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- click anywhere focuses the command input; keyboard users Tab straight into that native input
    <div
      className="desk-widget desk-ssh"
      data-resource={resourceId}
      onClick={focusInput}
      role="application"
      aria-label={`SSH terminal ${session.user}@${session.host}`}
    >
      <div className="desk-ssh-titlebar">
        <div className="desk-ssh-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="desk-ssh-title">
          <span className={`desk-ssh-dot ${session.connected ? 'is-on' : ''}`} aria-hidden />
          <span className="desk-ssh-host">
            {session.user}@{session.host}
            <span className="desk-ssh-port">:{session.port}</span>
          </span>
        </div>
        <span className="desk-ssh-badge">SSH · demo</span>
      </div>

      <div className="desk-ssh-body" ref={scrollerRef}>
        {lines.map((ln) => {
          if (ln.kind === 'cmd') {
            return (
              <div key={ln.id} className="desk-ssh-line desk-ssh-line--cmd">
                <span className="desk-ssh-prompt">{ln.prompt}</span>
                <span className="desk-ssh-cmd">{ln.text}</span>
              </div>
            )
          }
          return (
            <div
              key={ln.id}
              className={`desk-ssh-line desk-ssh-line--${ln.kind}`}
            >
              {ln.text}
            </div>
          )
        })}

        <form className="desk-ssh-input-row" onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor={inputId}>
            Terminal command
          </label>
          <span className="desk-ssh-prompt" aria-hidden>
            {promptOf(session)}
          </span>
          <input
            id={inputId}
            ref={inputRef}
            className="desk-ssh-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy}
            aria-label="Command input"
          />
          <span className={`desk-ssh-caret ${busy ? 'is-busy' : ''}`} aria-hidden />
        </form>
      </div>

      <div className="desk-ssh-statusbar">
        <span>utf-8</span>
        <span>bash</span>
        <span>{session.cwd}</span>
        <span className="desk-ssh-hint">↑↓ history · Ctrl+L clear · help</span>
      </div>
    </div>
  )
}
