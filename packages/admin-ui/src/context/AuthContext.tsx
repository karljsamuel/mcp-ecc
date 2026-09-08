import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { authApi, infoApi, setUnauthorizedHandler, type AuthUser } from '../api';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  needsBootstrap: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const PUBLIC_PATHS = ['/login', '/bootstrap'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const initialCheckDone = useRef(false);
  const authGeneration = useRef(0);

  const redirectToLogin = useCallback(() => {
    setUser(null);
    if (!PUBLIC_PATHS.includes(location.pathname)) {
      navigate('/login', { replace: true });
    }
  }, [navigate, location.pathname]);

  // Only set the unauthorized handler AFTER the initial auth check resolves.
  // During initial load, refresh() handles the 401 itself.
  useEffect(() => {
    if (!initialCheckDone.current) return;
    setUnauthorizedHandler(redirectToLogin);
    return () => setUnauthorizedHandler(null);
  }, [redirectToLogin]);

  const refresh = useCallback(async () => {
    const checkGeneration = ++authGeneration.current;
    try {
      const { user: u } = await authApi.me();
      if (checkGeneration !== authGeneration.current) return authGeneration.current ? user : null;
      setUser(u);
      setLoading(false);
      setNeedsBootstrap(false);
      initialCheckDone.current = true;
      return u;
    } catch {
      if (checkGeneration !== authGeneration.current) return user;
      // Not logged in — check whether we need to bootstrap the first admin.
      try {
        const { needsBootstrap } = await infoApi.bootstrapStatus();
        setNeedsBootstrap(!!needsBootstrap);
      } catch {
        setNeedsBootstrap(false);
      }
      setUser(null);
      setLoading(false);
      initialCheckDone.current = true;
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      ++authGeneration.current;
      const { user: u } = await authApi.login(username, password);
      setUser(u);
      setNeedsBootstrap(false);
    },
    [],
  );

  const logout = useCallback(async () => {
    setUser(null);
    setNeedsBootstrap(false);
    try {
      await authApi.logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, needsBootstrap, login, logout, refresh }),
    [user, loading, needsBootstrap, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}