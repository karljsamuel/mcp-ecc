import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  setupApi,
  type SetupAnswers,
  type SetupState,
  type SetupStepResult,
} from '../api';
import { Alert, Modal, Spinner } from '../components/ui';
import type { ToastPush } from './toast';

/**
 * First-run setup wizard.
 *
 * The management API starts in SETUP MODE when it has no usable configuration:
 * every /api route answers 503, and only /api/setup/* (loopback + one-time token)
 * is reachable. This page drives the shared setup engine in @mcp-ecc/core step by
 * step. In a container the final step returns the rendered .env so it can be
 * copied to the host — that content is held in a ref and is never rendered.
 */

const STEP_ORDER = [
  'database',
  'database-config',
  'verify-connection',
  'encryption-key',
  'server',
  'admin',
  'review',
] as const;

type WizardStep = (typeof STEP_ORDER)[number];

const STEP_TITLES: Record<WizardStep, string> = {
  database: 'Database provider',
  'database-config': 'Database configuration',
  'verify-connection': 'Verify the connection',
  'encryption-key': 'Encryption key',
  server: 'Server settings',
  admin: 'Administrator account',
  review: 'Review and apply',
};

type KeyMode = 'generate' | 'reuse' | 'provided';

interface Form {
  dbProvider: string;
  storageFile: string;
  d1AccountId: string;
  d1DatabaseId: string;
  d1ApiToken: string;
  keyMode: KeyMode;
  encryptionKey: string;
  port: string;
  host: string;
  publicUrl: string;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminConfirm: string;
}

function blankForm(state: SetupState): Form {
  const defaults = state.defaults;
  return {
    dbProvider: state.current.dbProvider || defaults.dbProvider || 'sqlite',
    storageFile: defaults.storageFile,
    d1AccountId: '',
    d1DatabaseId: '',
    d1ApiToken: '',
    keyMode: state.current.hasEncryptionKey ? 'reuse' : 'generate',
    encryptionKey: '',
    port: defaults.port,
    host: defaults.host,
    publicUrl: defaults.publicUrl,
    adminUsername: 'admin',
    adminDisplayName: '',
    adminPassword: '',
    adminConfirm: '',
  };
}

export function Setup({ push }: { push: ToastPush }) {
  const navigate = useNavigate();

  const [token, setToken] = useState('');
  const [state, setState] = useState<SetupState | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<SetupStepResult | null>(null);

  // The generated .env is kept in a ref so it never enters the rendered tree.
  const envContentRef = useRef('');
  const [hasEnvContent, setHasEnvContent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);

  const step: WizardStep = STEP_ORDER[stepIndex];

  const answers = useMemo<SetupAnswers>(() => {
    if (!form) return {};
    const base: SetupAnswers = {
      dbProvider: form.dbProvider,
      port: form.port.trim(),
      host: form.host.trim(),
      publicUrl: form.publicUrl.trim(),
      admin: {
        username: form.adminUsername.trim(),
        displayName: form.adminDisplayName.trim() || form.adminUsername.trim(),
        password: form.adminPassword,
      },
    };
    if (form.dbProvider === 'd1') {
      base.d1 = {
        accountId: form.d1AccountId.trim(),
        databaseId: form.d1DatabaseId.trim(),
        apiToken: form.d1ApiToken.trim(),
      };
    } else {
      base.storageFile = form.storageFile.trim();
    }
    // 'generate' forces a brand-new key; omitting it lets the server reuse an
    // existing MCP_ENCRYPTION_KEY when one is present.
    if (form.keyMode === 'generate') base.encryptionKey = 'generate';
    if (form.keyMode === 'provided') base.encryptionKey = form.encryptionKey.trim();
    return base;
  }, [form]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setErrors([]);
    setBusy(true);
    try {
      const next = await setupApi.state(token.trim());
      setState(next);
      setForm(blankForm(next));
      push('Setup token accepted', 'success');
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401) setError('Invalid setup token. Copy the token printed in the server console and try again.');
      else if (status === 403) setError('Setup is only reachable from localhost on the machine running the server.');
      else if (status === 409) setError((err as { message?: string })?.message ?? 'Setup has already been completed.');
      else setError((err as { message?: string })?.message ?? 'Could not reach the setup endpoint.');
    } finally {
      setBusy(false);
    }
  };

  const runStep = useCallback(
    async (target: WizardStep, nextIndex: number) => {
      setError(null);
      setErrors([]);
      setBusy(true);
      try {
        const res = await setupApi.step(token.trim(), target, answers);
        if (target === 'verify-connection') {
          if (res.ok) {
            setVerified(true);
            push('Database connection verified', 'success');
            setStepIndex(nextIndex);
          } else {
            setError(res.error || 'Database connection failed');
          }
          return;
        }
        if (!res.ok) {
          setErrors(res.errors ?? (res.error ? [res.error] : ['Validation failed']));
          return;
        }
        setStepIndex(nextIndex);
      } catch (err: unknown) {
        setError((err as { message?: string })?.message ?? 'Request failed');
      } finally {
        setBusy(false);
      }
    },
    [answers, push, token],
  );

  const apply = useCallback(async () => {
    setError(null);
    setErrors([]);
    if (form && form.adminPassword !== form.adminConfirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await setupApi.step(token.trim(), 'apply', answers);
      if (!res.ok) {
        setErrors(res.errors ?? (res.error ? [res.error] : ['Setup failed']));
        return;
      }
      // Handoff content stays in the ref: it is copied, never displayed.
      if (res.envContent) {
        envContentRef.current = res.envContent;
        setHasEnvContent(true);
      }
      setResult(res);
      if (res.handoff) setShowHandoff(true);
      push('Configuration applied', 'success');
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? 'Setup failed');
    } finally {
      setBusy(false);
    }
  }, [answers, form, push, token]);

  const copyEnv = async () => {
    try {
      await navigator.clipboard.writeText(envContentRef.current);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      push('Clipboard unavailable in this browser context', 'error');
    }
  };

  // --- Token gate --------------------------------------------------------
  if (!state || !form) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-100 p-4">
        <div className="mb-6 w-full max-w-md">
          <img src="/Logo.png" alt="mcp-ecc" className="mx-auto w-3/4 object-contain" />
        </div>
        <div className="card w-full max-w-lg p-8">
          <h1 className="text-xl font-semibold text-slate-900">First-run setup</h1>
          <p className="mt-1 text-sm text-slate-500">
            This instance has no configuration yet, so the API is running in setup mode. Enter the
            one-time token printed in the server console to continue.
          </p>

          {error && (
            <div className="mt-4">
              <Alert tone="error">{error}</Alert>
            </div>
          )}

          <form onSubmit={unlock} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="setup-token">
                Setup token
              </label>
              <input
                id="setup-token"
                className="input font-mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="hex token from the server console"
                autoFocus
                required
              />
              <p className="mt-1 text-xs text-slate-400">
                Sent as a header. Never stored in the URL, a log, or a response.
              </p>
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- Completion --------------------------------------------------------
  if (result) {
    return (
      <div className="mx-auto flex min-h-screen max-w-2xl items-start justify-center bg-slate-100 p-4 py-12">
        <div className="card w-full p-8">
          <h1 className="text-xl font-semibold text-slate-900">Setup complete</h1>
          {result.warning && (
            <div className="mt-4">
              <Alert tone="error">{result.warning}</Alert>
            </div>
          )}
          {result.handoff ? (
            <div className="mt-4">
              <Alert tone="info">
                This container cannot persist <code>.env</code>, so the configuration was not written
                to disk. Use the button below to copy it into the <code>.env</code> file next to your{' '}
                <code>docker-compose.yml</code>.
              </Alert>
              <button className="btn-primary mt-4" onClick={() => setShowHandoff(true)}>
                Show copy instructions
              </button>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <Alert tone="success">
                Configuration written to <code>{result.envPath}</code>.
              </Alert>
              {result.restartReason && <p className="text-sm text-slate-500">{result.restartReason}</p>}
            </div>
          )}

          {result.adminCreated ? (
            <p className="mt-4 text-sm text-slate-600">
              Administrator <strong>@{result.adminCreated.username}</strong> created. Sign in to continue.
            </p>
          ) : (
            <p className="mt-4 text-sm text-slate-600">No administrator was created.</p>
          )}

          {result.nextSteps && result.nextSteps.length > 0 && (
            <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-500">
              {result.nextSteps.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          <button className="btn-primary mt-6 w-full" onClick={() => navigate('/login', { replace: true })}>
            Go to sign in
          </button>
        </div>

        <Modal
          open={showHandoff}
          onClose={() => setShowHandoff(false)}
          title="Copy the .env into your compose folder"
          wide
        >
          <div className="space-y-4">
            <Alert tone="info">
              The content is never rendered on this page. Press the button to put it on the
              clipboard, then paste it into the <code>.env</code> file that sits next to your{' '}
              <code>docker-compose.yml</code>.
            </Alert>
            <button className="btn-primary w-full" onClick={copyEnv} disabled={!hasEnvContent}>
              {copied ? 'Copied to clipboard' : 'Copy .env content'}
            </button>
            {result.handoffInstructions && (
              <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
                {result.handoffInstructions.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            )}
          </div>
        </Modal>
      </div>
    );
  }

  // --- Wizard ------------------------------------------------------------
  const canGoBack = stepIndex > 0;
  const isLast = step === 'review';

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl items-start justify-center bg-slate-100 p-4 py-10">
      <div className="card w-full p-8">
        <div className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Step {stepIndex + 1} of {STEP_ORDER.length}
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">{STEP_TITLES[step]}</h1>
          {step === 'database' && (
            <p className="mt-1 text-sm text-slate-500">
              The setup engine writes a <code>.env</code> file with the same variables the CLI uses.
            </p>
          )}
        </div>

        {state.configIssues.length > 0 && step === 'database' && (
          <div className="mb-4">
            <Alert tone="info">
              Missing configuration: {state.configIssues.join(', ')}
            </Alert>
          </div>
        )}
        {state.usersExist !== null && state.usersExist > 0 && (
          <div className="mb-4">
            <Alert tone="error">
              This database already contains {state.usersExist} user account(s). Setup only configures
              an empty database — repair the existing configuration instead.
            </Alert>
          </div>
        )}
        {error && (
          <div className="mb-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        {errors.length > 0 && (
          <div className="mb-4">
            <Alert tone="error">
              <ul className="list-disc space-y-1 pl-4">
                {errors.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Alert>
          </div>
        )}

        <div className="space-y-4">
          {step === 'database' && (
            <>
              {[
                { value: 'sqlite', label: 'SQLite', hint: 'A local file. No external service.' },
                { value: 'd1', label: 'Cloudflare D1', hint: 'Hosted. Needs an account, database and API token.' },
              ].map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50"
                >
                  <input
                    type="radio"
                    className="mt-1"
                    name="dbProvider"
                    value={option.value}
                    checked={form.dbProvider === option.value}
                    onChange={() => set('dbProvider', option.value)}
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-800">{option.label}</span>
                    <span className="block text-xs text-slate-500">{option.hint}</span>
                  </span>
                </label>
              ))}
            </>
          )}

          {step === 'database-config' && form.dbProvider === 'sqlite' && (
            <div>
              <label className="label" htmlFor="s-file">
                SQLite database file
              </label>
              <input
                id="s-file"
                className="input font-mono"
                value={form.storageFile}
                onChange={(e) => set('storageFile', e.target.value)}
                placeholder="/data/mcp-ecc.db"
              />
              <p className="mt-1 text-xs text-slate-400">Written as MCP_STORAGE_FILE.</p>
            </div>
          )}

          {step === 'database-config' && form.dbProvider === 'd1' && (
            <>
              <div>
                <label className="label" htmlFor="d1-account">
                  Cloudflare account ID
                </label>
                <input
                  id="d1-account"
                  className="input font-mono"
                  value={form.d1AccountId}
                  onChange={(e) => set('d1AccountId', e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="d1-db">
                  D1 database ID
                </label>
                <input
                  id="d1-db"
                  className="input font-mono"
                  value={form.d1DatabaseId}
                  onChange={(e) => set('d1DatabaseId', e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="d1-token">
                  Cloudflare API token (D1:Edit)
                </label>
                <input
                  id="d1-token"
                  className="input font-mono"
                  type="password"
                  value={form.d1ApiToken}
                  onChange={(e) => set('d1ApiToken', e.target.value)}
                />
              </div>
            </>
          )}

          {step === 'verify-connection' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                The connection is tested for real before anything is written. Setup will not continue
                until it succeeds.
              </p>
              {verified ? (
                <Alert tone="success">Connection verified.</Alert>
              ) : (
                <Alert tone="info">Not verified yet. Press the button below to test it.</Alert>
              )}
              <button className="btn-secondary" onClick={() => void runStep('verify-connection', stepIndex + 1)} disabled={busy}>
                {busy ? 'Testing…' : verified ? 'Test again' : 'Test connection'}
              </button>
            </div>
          )}

          {step === 'encryption-key' && (
            <>
              <p className="text-sm text-slate-600">
                The master key encrypts stored credentials (AES-256-GCM). It is written to{' '}
                <code>.env</code> as MCP_ENCRYPTION_KEY. The session cookie secret is generated
                separately and never derived from this key.
              </p>
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="keyMode"
                  checked={form.keyMode === 'generate'}
                  onChange={() => set('keyMode', 'generate')}
                />
                <span className="text-sm text-slate-700">
                  Generate a new key <span className="text-xs text-slate-400">(recommended for a fresh install)</span>
                </span>
              </label>
              {state.current.hasEncryptionKey && (
                <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
                  <input
                    type="radio"
                    className="mt-1"
                    name="keyMode"
                    checked={form.keyMode === 'reuse'}
                    onChange={() => set('keyMode', 'reuse')}
                  />
                  <span className="text-sm text-slate-700">
                    Keep the MCP_ENCRYPTION_KEY already present in the environment
                  </span>
                </label>
              )}
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3">
                <input
                  type="radio"
                  className="mt-1"
                  name="keyMode"
                  checked={form.keyMode === 'provided'}
                  onChange={() => set('keyMode', 'provided')}
                />
                <span className="text-sm text-slate-700">Use my own key</span>
              </label>
              {form.keyMode === 'provided' && (
                <input
                  className="input font-mono"
                  type="password"
                  value={form.encryptionKey}
                  onChange={(e) => set('encryptionKey', e.target.value)}
                  placeholder="at least 32 characters (openssl rand -hex 32)"
                />
              )}
            </>
          )}

          {step === 'server' && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="s-port">
                    PORT
                  </label>
                  <input
                    id="s-port"
                    className="input"
                    value={form.port}
                    onChange={(e) => set('port', e.target.value)}
                  />
                  <p className="mt-1 text-xs text-slate-400">HOST_PORT is written with the same value for docker-compose.</p>
                </div>
                <div>
                  <label className="label" htmlFor="s-host">
                    HOST
                  </label>
                  <input
                    id="s-host"
                    className="input"
                    value={form.host}
                    onChange={(e) => set('host', e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="s-url">
                  PUBLIC_URL
                </label>
                <input
                  id="s-url"
                  className="input"
                  value={form.publicUrl}
                  onChange={(e) => set('publicUrl', e.target.value)}
                />
              </div>
              <p className="text-xs text-slate-400">
                SESSION_SECRET is generated independently of the master key.
              </p>
            </>
          )}

          {step === 'admin' && (
            <>
              <div>
                <label className="label" htmlFor="a-user">
                  Username
                </label>
                <input
                  id="a-user"
                  className="input"
                  value={form.adminUsername}
                  onChange={(e) => set('adminUsername', e.target.value)}
                  autoComplete="username"
                />
              </div>
              <div>
                <label className="label" htmlFor="a-name">
                  Display name
                </label>
                <input
                  id="a-name"
                  className="input"
                  value={form.adminDisplayName}
                  onChange={(e) => set('adminDisplayName', e.target.value)}
                  autoComplete="name"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="a-pass">
                    Password
                  </label>
                  <input
                    id="a-pass"
                    className="input"
                    type="password"
                    value={form.adminPassword}
                    onChange={(e) => set('adminPassword', e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="a-confirm">
                    Confirm password
                  </label>
                  <input
                    id="a-confirm"
                    className="input"
                    type="password"
                    value={form.adminConfirm}
                    onChange={(e) => set('adminConfirm', e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-400">At least 8 characters. Created only if the database has no users.</p>
            </>
          )}

          {step === 'review' && (
            <dl className="divide-y divide-slate-100 text-sm">
              <div className="flex justify-between py-2">
                <dt className="text-slate-500">Database</dt>
                <dd className="font-medium text-slate-800">{form.dbProvider}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-slate-500">{form.dbProvider === 'd1' ? 'D1 database' : 'Storage file'}</dt>
                <dd className="max-w-[60%] truncate font-mono text-xs text-slate-700">
                  {form.dbProvider === 'd1' ? form.d1DatabaseId : form.storageFile}
                </dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-slate-500">Encryption key</dt>
                <dd className="font-medium text-slate-800">
                  {form.keyMode === 'generate' ? 'generate a new one' : form.keyMode === 'reuse' ? 'reuse existing' : 'provided'}
                </dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-slate-500">Server</dt>
                <dd className="font-medium text-slate-800">
                  {form.host}:{form.port}
                </dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-slate-500">Public URL</dt>
                <dd className="font-mono text-xs text-slate-700">{form.publicUrl}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-slate-500">Administrator</dt>
                <dd className="font-medium text-slate-800">@{form.adminUsername}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-slate-500">Config file</dt>
                <dd className="max-w-[60%] truncate font-mono text-xs text-slate-700">{state.envPath}</dd>
              </div>
            </dl>
          )}
        </div>

        <div className="mt-8 flex items-center justify-between gap-3">
          <button
            className="btn-secondary"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={!canGoBack || busy}
          >
            Back
          </button>

          {busy && <Spinner />}

          {isLast ? (
            <button className="btn-primary" onClick={() => void apply()} disabled={busy}>
              {busy ? 'Applying…' : 'Apply configuration'}
            </button>
          ) : step === 'verify-connection' ? (
            <button
              className="btn-primary"
              onClick={() => (verified ? setStepIndex(stepIndex + 1) : void runStep('verify-connection', stepIndex + 1))}
              disabled={busy}
            >
              {verified ? 'Continue' : 'Test connection'}
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => void runStep(step, stepIndex + 1)}
              disabled={busy}
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
