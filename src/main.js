// @ts-check

import './style.css';

/**
 * A serialisable snapshot of the document.
 * @typedef {Object} DocumentState
 * @property {string} content - Current document contents.
 * @property {string[]} edits - Chronological log of edits.
 */

/**
 * Create the initial document state.
 * @param {string} [initialContent='So it goes.']
 * @returns {DocumentState}
 */
export const createDocumentState = (initialContent = 'So it goes.') => ({
  content: initialContent,
  edits: [],
});

/**
 * Record a new edit and update the content.
 * @param {DocumentState} state
 * @param {string} nextContent
 * @returns {DocumentState}
 */
export const applyEdit = (state, nextContent) => ({
  content: nextContent,
  edits: [...state.edits, state.content],
});

/**
 * Wire up the editable field with lightweight change tracking.
 * @param {HTMLElement | null} root
 */
const bootstrapEditor = (root) => {
  if (!root) return;

  const contentEditable = root;
  let currentState = createDocumentState(contentEditable.textContent ?? '');

  contentEditable.addEventListener('input', () => {
    currentState = applyEdit(currentState, contentEditable.textContent ?? '');
    console.debug('Document state snapshot', currentState);
  });
};

bootstrapEditor(document.querySelector('p[contenteditable="true"]'));
