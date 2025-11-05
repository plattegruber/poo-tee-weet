// @ts-check

import { Clerk } from '@clerk/clerk-js';
import './style.css';

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!clerkPublishableKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY. Set it in your environment.');
}

const clerk = new Clerk(clerkPublishableKey);
const appOrigin = window.location.href.split('#')[0];
const AUTH_HASHES = {
  signIn: '#/sign-in',
  signUp: '#/sign-up',
};

/**
 * Wire up the editable field with lightweight change tracking.
 * @param {HTMLElement | null} root
 */
const bootstrapEditor = (root) => {
  if (!root || root.hasChildNodes()) return;

  const firstParagraph = document.createElement('p');
  firstParagraph.textContent = 'A distraction free writing tool.';

  const secondParagraph = document.createElement('p');
  secondParagraph.textContent = 'So it goes.';

  root.replaceChildren(firstParagraph, secondParagraph);
};

/**
 * Ensure the user button root exists so Clerk can mount into it.
 * @returns {HTMLDivElement}
 */
const ensureUserButtonRoot = () => {
  const existing = document.getElementById('user-button');
  if (existing instanceof HTMLDivElement) {
    existing.replaceChildren();
    return existing;
  }

  if (existing) {
    existing.remove();
  }

  const container = document.createElement('div');
  container.id = 'user-button';
  container.className = 'user-button';
  document.body.appendChild(container);
  return container;
};

/**
 * Make sure the auth container exists before mounting Clerk's UI.
 * @param {HTMLElement} host
 * @returns {HTMLDivElement}
 */
const ensureAuthRoot = (host) => {
  const existing = host.querySelector('#auth-root');
  if (existing instanceof HTMLDivElement) {
    existing.replaceChildren();
    return existing;
  }

  const container = document.createElement('div');
  container.id = 'auth-root';
  container.className = 'auth-root';
  host.replaceChildren(container);
  return container;
};

/**
 * Remove the user button from the DOM when the visitor signs out.
 */
const teardownUserButton = () => {
  const container = document.getElementById('user-button');
  if (!container) return;
  container.replaceChildren();
  container.remove();
};

/**
 * Render the signed-in view with the editor and user button.
 */
const renderSignedIn = () => {
  const main = document.querySelector('main');
  if (!main) return;

  main.replaceChildren();
  main.contentEditable = 'true';
  main.removeAttribute('aria-busy');
  main.focus();

  bootstrapEditor(main);

  const userButtonRoot = ensureUserButtonRoot();
  clerk.mountUserButton(userButtonRoot);
  window.history.replaceState(null, '', appOrigin);
};

/**
 * Render the signed-out view with Clerk's SignIn component.
 */
const renderSignedOut = () => {
  const main = document.querySelector('main');
  if (!main) return;

  main.contentEditable = 'false';
  main.setAttribute('aria-busy', 'true');

  const authRoot = ensureAuthRoot(main);
  const isSignUp = window.location.hash === AUTH_HASHES.signUp;

  const sharedOptions = {
    afterSignInUrl: appOrigin,
    afterSignUpUrl: appOrigin,
    signInUrl: AUTH_HASHES.signIn,
    signUpUrl: AUTH_HASHES.signUp,
  };

  if (isSignUp) {
    clerk.mountSignUp(authRoot, sharedOptions);
  } else {
    clerk.mountSignIn(authRoot, sharedOptions);
  }

  teardownUserButton();
};

/**
 * Sync the UI with the current authentication state.
 */
const renderApp = () => {
  if (clerk.isSignedIn) {
    renderSignedIn();
  } else {
    renderSignedOut();
  }
};

await clerk.load();

const handleHashChange = () => {
  if (!clerk.isSignedIn) {
    renderSignedOut();
  }
};

window.addEventListener('hashchange', handleHashChange);
clerk.addListener(renderApp);
renderApp();
