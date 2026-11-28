import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LoginPage } from './LoginPage';
import * as api from '@/lib/api';

jest.mock('react-router-dom', () => ({ useLocation: () => ({}), useNavigate: () => jest.fn() }));
jest.mock('@/lib/api', () => ({
  apiLogin: jest.fn(), apiLoginOptions: jest.fn(), apiMobileLogin: jest.fn(),
  apiVerifyMobileLogin: jest.fn(), apiResendMobileLogin: jest.fn(),
  apiVerifyLogin2fa: jest.fn(), apiResendLogin2fa: jest.fn(),
}), { virtual: true });
jest.mock('@/components/ui/card', () => ({ Card: 'div', CardContent: 'div', CardHeader: 'div' }), { virtual: true });
jest.mock('@/components/ui/input', () => ({ Input: 'input' }), { virtual: true });
jest.mock('@/components/ui/button', () => ({ Button: 'button' }), { virtual: true });
jest.mock('@/components/ui/sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }), { virtual: true });
jest.mock('@/components/ForgotPasswordModal', () => ({ ForgotPasswordModal: () => null }), { virtual: true });
jest.mock('@/components/LegalLinks', () => ({ LegalLinks: () => null }), { virtual: true });
jest.mock('@/lib/version', () => ({ versionLabel: 'test', versionDetail: 'test' }), { virtual: true });
jest.mock('@/components/ui/code-input', () => ({
  CODE_LENGTH: 6,
  CodeInput: ({ value, onChange, testid }) => <input data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)} />,
}), { virtual: true });

let container;
let root;
let onLogin;
const get = (id) => container.querySelector(`[data-testid="${id}"]`);
const sms = { two_factor_required: true, channel: 'sms', challenge_id: 'sms-id', phone_masked: '********3210', resend_after: 60 };

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onLogin = jest.fn();
  api.apiLoginOptions.mockResolvedValue({ mobile_sms_enabled: true });
  api.apiMobileLogin.mockResolvedValue(sms);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => root.render(<LoginPage onLogin={onLogin} />));
}

async function input(id, value) {
  await act(async () => {
    const element = get(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(id) {
  await act(async () => get(id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

async function startMobile() {
  await render();
  await act(async () => get('screen1-login-method-mobile').click());
  await input('screen1-login-mobile-input', '+919876543210');
  await input('screen1-login-password-input', 'password');
  await submit('screen1-login-form');
}

test('unconfigured SMS leaves the email login available', async () => {
  api.apiLoginOptions.mockResolvedValue({ mobile_sms_enabled: false });
  await render();
  expect(get('screen1-login-email-input')).not.toBeNull();
  expect(get('screen1-login-method-mobile')).toBeNull();
});

test('mobile password login shows a masked SMS challenge without signing in', async () => {
  await startMobile();
  expect(api.apiMobileLogin).toHaveBeenCalledWith('+919876543210', 'password');
  expect(container.textContent).toContain('Verify your Mobile Number');
  expect(container.textContent).toContain('********3210');
  expect(get('screen1-login-2fa-resend').disabled).toBe(true);
  expect(onLogin).not.toHaveBeenCalled();
});

test('SMS verification completes sign-in only with a session response', async () => {
  api.apiVerifyMobileLogin.mockResolvedValue({ token: 'session', user: { id: 'u1' } });
  await startMobile();
  await input('screen1-login-2fa-input', '123456');
  await submit('screen1-login-2fa-form');
  expect(api.apiVerifyMobileLogin).toHaveBeenCalledWith('sms-id', '123456');
  expect(onLogin).toHaveBeenCalledWith({ token: 'session', user: { id: 'u1' } });
});

test('an existing email two-factor gate is still displayed after SMS', async () => {
  api.apiVerifyMobileLogin.mockResolvedValue({ two_factor_required: true, challenge_id: 'email-id', email_masked: 't***@example.com' });
  await startMobile();
  await input('screen1-login-2fa-input', '123456');
  await submit('screen1-login-2fa-form');
  expect(container.textContent).toContain('Check your email');
  expect(onLogin).not.toHaveBeenCalled();
  api.apiVerifyLogin2fa.mockResolvedValue({ token: 'email-session' });
  await input('screen1-login-2fa-input', '654321');
  await submit('screen1-login-2fa-form');
  expect(api.apiVerifyLogin2fa).toHaveBeenCalledWith('email-id', '654321');
  expect(onLogin).toHaveBeenCalledWith({ token: 'email-session' });
});

test('failed SMS verification does not sign in', async () => {
  api.apiVerifyMobileLogin.mockRejectedValue({ response: { data: { detail: 'Wrong code' } } });
  await startMobile();
  await input('screen1-login-2fa-input', '000000');
  await submit('screen1-login-2fa-form');
  expect(onLogin).not.toHaveBeenCalled();
  expect(get('screen1-login-2fa-form')).not.toBeNull();
});
