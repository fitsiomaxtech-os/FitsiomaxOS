import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "@/App.css";
import { LoginPage } from "@/pages/LoginPage";
import { clearSession, loadSession, saveSession } from "@/lib/session";
import { apiMe, MY_PHOTO_CHANGED_EVENT } from "@/lib/api";

/**
 * Everything behind the login screen is split out of the first download.
 *
 * These five were static imports, which is what made the app one 2.6MB bundle: webpack
 * follows CRMPage into all twenty-two boards, those into ConsultationsBoard and the
 * charts, and the whole tree landed in the file the browser has to fetch and parse before
 * it can paint the login form. Somebody signing in downloaded Finance, HR, Zumba and
 * Marketing to look at a username field.
 *
 * LoginPage stays static on purpose. It is what the first paint is, so splitting it would
 * add a network round trip to the one screen that has nothing to wait for.
 *
 * The portal and testimonials routes are public and reached by patients on phones, and
 * they carry none of the CRM -- keeping them out of the shared bundle is most of the point
 * for the people least likely to be on good wifi.
 */
const CRMPage = lazy(() => import("@/pages/CRMPage").then((m) => ({ default: m.CRMPage })));
const CreateSuperAdminPublicPage = lazy(() => import("@/pages/CreateSuperAdminPublicPage").then((m) => ({ default: m.CreateSuperAdminPublicPage })));
const ResetPasswordPage = lazy(() => import("@/pages/ResetPasswordPage").then((m) => ({ default: m.ResetPasswordPage })));
const PatientPortalPage = lazy(() => import("@/pages/PatientPortalPage").then((m) => ({ default: m.PatientPortalPage })));
const TestimonialsPage = lazy(() => import("@/pages/TestimonialsPage").then((m) => ({ default: m.TestimonialsPage })));

/**
 * What a route shows while its chunk is on the wire.
 *
 * Deliberately almost nothing: a spinner on a blank page for the fraction of a second a
 * cached chunk takes reads as a slower app than no spinner at all. This is sized and
 * centred so the page does not jump when the real screen replaces it.
 */
const RouteFallback = () => (
  <div className="flex min-h-screen items-center justify-center bg-slate-50" data-testid="route-loading">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-sky-600" />
  </div>
);

const RequireAuth = ({ isAuthenticated, children }) => {
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }
  return children;
};

function App() {
  const [auth, setAuth] = useState(loadSession());

  const isAuthenticated = useMemo(() => Boolean(auth?.token), [auth]);

  useEffect(() => {
    if (!auth?.token) return;
    apiMe()
      .then((user) => {
        setAuth((prev) => {
          if (!prev) return prev;
          const next = { ...prev, user };
          saveSession(next);
          return next;
        });
      })
      .catch(() => { /* keep cached profile if the refresh fails */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.token]);

  // My Profile's photo upload, deep inside whichever board is open — told here so the
  // header avatar, drawn from this copy of the user, changes with it.
  useEffect(() => {
    const onPhoto = (e) => {
      setAuth((prev) => {
        if (!prev?.user) return prev;
        const next = { ...prev, user: { ...prev.user, photo_url: e.detail || "" } };
        saveSession(next);
        return next;
      });
    };
    window.addEventListener(MY_PHOTO_CHANGED_EVENT, onPhoto);
    return () => window.removeEventListener(MY_PHOTO_CHANGED_EVENT, onPhoto);
  }, []);

  const handleLogin = (loginResponse) => {
    saveSession(loginResponse);
    setAuth(loginResponse);
  };

  const handleLogout = () => {
    clearSession();
    setAuth(null);
  };

  return (
    <BrowserRouter>
      {/* One boundary around the table rather than one per route: only ever a single route
          is resolving, and five identical fallbacks would say the same thing five times. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route
            path="/"
            element={
              isAuthenticated ? (
                <Navigate to="/app" replace />
              ) : (
                <LoginPage onLogin={handleLogin} />
              )
            }
          />
          <Route
            path="/app"
            element={
              <RequireAuth isAuthenticated={isAuthenticated}>
                <CRMPage auth={auth} onLogout={handleLogout} />
              </RequireAuth>
            }
          />
          <Route path="/createsuperadmin" element={<CreateSuperAdminPublicPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/portal" element={<PatientPortalPage />} />
          <Route path="/testimonials" element={<TestimonialsPage />} />
          <Route path="*" element={<Navigate to={isAuthenticated ? "/app" : "/"} replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
