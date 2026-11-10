import { BrandFooter } from '@/components/BrandFooter';
import { type FormEvent, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, ShieldCheck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError, setCsrfToken } from '../api/client';
import { Brand } from '../components/Brand';
import { Button, Field } from '../components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useI18n } from '@/i18n';
import type { Session } from '../types';
import { BRAND_NAME, useBranding } from '../lib/brand';

export function LoginPage() {
  const { t } = useI18n();
  const { profile } = useBranding();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [code, setCode] = useState('');

  useEffect(() => {
    document.title = `${t('Sign in', 'Anmelden')} · ${BRAND_NAME}`;
  }, [t]);

  const login = useMutation({
    mutationFn: () => mfaRequired ? api.verifyMfa(code.trim().toLowerCase().replace(/\s/g, "")) : api.login({ email: email.trim(), password }),
    onSuccess: async (session) => {
      if ("mfaRequired" in session) { setMfaRequired(true); setPassword(""); return; }
      if (session?.user) {
        setCsrfToken(session.csrfToken);
        queryClient.setQueryData<Session>(['session'], session);
      } else {
        await queryClient.invalidateQueries({ queryKey: ['session'] });
      }
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    },
  });

  function loginErrorMessage(error: unknown) {
    const details = error instanceof ApiError ? error.details : null;
    const code = details && typeof details === "object" && "code" in details ? details.code : null;
    if (code === "MFA_INVALID") return t("The code is invalid or expired. Use a new authenticator code, a recovery code, or start sign-in again.", "Der Code ist ungültig oder abgelaufen. Verwende einen neuen Authenticator-Code, einen Wiederherstellungscode oder starte die Anmeldung neu.");
    if (code === "INVALID_CREDENTIALS") return t("Email or password is incorrect.", "E-Mail-Adresse oder Passwort ist falsch.");
    return t("Sign-in could not be completed. Check your details and try again shortly.", "Die Anmeldung konnte nicht abgeschlossen werden. Prüfe deine Angaben und versuche es in Kürze erneut.");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mfaRequired ? !code.trim() : !email.trim() || !password) return;
    login.mutate();
  }

  return (
    <main className="relative grid min-h-svh place-items-center bg-muted/30 px-4 py-16 sm:px-6" aria-labelledby="login-title">
      <div className="absolute top-4 right-4 flex items-center gap-2 sm:top-6 sm:right-6">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Brand linkTo="/login" showClaim />
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              <h1 id="login-title">{mfaRequired ? t("Verify it’s you", "Anmeldung bestätigen") : t('Sign in', 'Anmelden')}</h1>
            </CardTitle>
            <CardDescription>
              {mfaRequired ? t('Enter the code from your authenticator app or use a recovery code.', 'Gib den Code aus deiner Authenticator-App oder einen Wiederherstellungscode ein.') : profile.loginMessage || t('Sign in with your Shelter administrator account.', 'Melde dich mit deinem Shelter-Admin-Konto an.')}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form className="grid gap-5" onSubmit={submit}>
              {mfaRequired ? <Field label={t("Verification code", "Bestätigungscode")} name="code" value={code} onChange={event => { setCode(event.target.value); login.reset(); }} autoComplete="one-time-code" autoFocus maxLength={24} disabled={login.isPending} required /> : <div className="grid gap-4">
                <Field
                  label={t('Email address', 'E-Mail-Adresse')}
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => {
                    if (login.isError) login.reset();
                    setEmail(event.target.value);
                  }}
                  placeholder="admin@example.com"
                  disabled={login.isPending}
                  required
                  autoFocus
                />
                <Field
                  label={t('Password', 'Passwort')}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    if (login.isError) login.reset();
                    setPassword(event.target.value);
                  }}
                  placeholder={t('Your password', 'Dein Passwort')}
                  disabled={login.isPending}
                  required
                />
              </div>}

              {login.isError && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{t('Sign-in failed', 'Anmeldung fehlgeschlagen')}</AlertTitle>
                  <AlertDescription>
                    {loginErrorMessage(login.error)}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                size="lg"
                className="h-11 w-full"
                loading={login.isPending}
                disabled={mfaRequired ? !code.trim() : !email.trim() || !password}
              >
                {login.isPending ? t('Signing in …', 'Anmeldung läuft …') : mfaRequired ? t('Verify and sign in', 'Bestätigen und anmelden') : t('Sign in', 'Anmelden')}
                {!login.isPending && <ArrowRight aria-hidden="true" />}
              </Button>
              {mfaRequired && <Button type="button" variant="ghost" disabled={login.isPending} onClick={() => { setMfaRequired(false); setCode(""); login.reset(); }}>{t("Back to sign-in", "Zurück zur Anmeldung")}</Button>}
            </form>

            <p className="mt-6 flex items-center justify-center gap-2 border-t pt-5 text-center text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {t('Encrypted connection to your installation', 'Verschlüsselte Verbindung zu deiner Installation')}
            </p>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">{t('Self-hosted deployment management', 'Self-hosted Deployment-Verwaltung')}</p>
        <BrandFooter />
      </div>
    </main>
  );
}
