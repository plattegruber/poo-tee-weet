// @ts-check

import './style.css';

/**
 * An appendchar-type DocumentEdit.
 * @typedef {Object} AppendCharDocumentEdit
 * @property {'appendChar'} type - the type of edit (must be 'appendChar')
 * @property {string} char - the character appended
 */

/**
 * A deletechar-type DocumentEdit.
 * @typedef {Object} DeleteCharDocumentEdit
 * @property {'deleteChar'} type - the type of edit (must be 'deleteChar')
 */

/**
 * An edit made by the user.
 * @typedef {AppendCharDocumentEdit | DeleteCharDocumentEdit} DocumentEdit
 */

/**
 * A serialisable snapshot of the document.
 * @typedef {Object} DocumentState
 * @property {string} content - Current document contents.
 * @property {DocumentEdit[]} edits - Chronological log of edits.
 */

/**
 * Create the initial document state.
 * @param {string} [initialContent='So it goes.']
 * @returns {DocumentState}
 */
export const createDocumentState = (
  initialContent = 'A distraction free text editor.\n\nSo it goes.'
) => ({
  content: initialContent,
  edits: [],
});

/**
 * Record a new edit and update the content.
 * @param {DocumentState} state
 * @param {DocumentEdit} edit
 * @returns {DocumentState}
 */
export const applyEdit = (state, edit) => {
  let newContent = state.content;

  switch (edit.type) {
    case 'appendChar':
      newContent = state.content + edit.char;
      break;
    case 'deleteChar':
      if (state.content.length > 0) {
        newContent = state.content.slice(0, -1);
      }
      break;
    default:
      // Unknown edit type, don't modify content
      break;
  }

  // Ignore edits that don't result in a content change.
  if (newContent === state.content) return state;

  return {
    content: newContent,
    edits: [...state.edits, edit],
  };
};

/**
 * Generate valid HTML from markdown.
 * @param {string} markdown
 * @returns {HTMLElement[]}
 */
export const markdownToHtml = (/** @type {string} */ markdown) => {
  const paragraphs = markdown.split('\n\n');
  return paragraphs.map(toPTag);
};

/**
 * Generate a populated paragraph element given some text.
 * @param {string} text
 * @returns {HTMLParagraphElement}
 */
export const toPTag = (/** @type {string} */ text) => {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  return paragraph;
};

/**
 * Save the current cursor position in contentEditable.
 * @param {HTMLElement} root
 * @returns {{offset: number}}
 */
const saveCursorPosition = (root) => {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return { offset: 0 };

  const range = selection.getRangeAt(0);

  // Calculate total offset from start of all text content
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  let node;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      offset += range.startOffset;
      break;
    }
    offset += node.textContent?.length || 0;
  }

  return { offset };
};

/**
 * Restore cursor position in contentEditable.
 * @param {HTMLElement} root
 * @param {{offset: number}} position
 */
const restoreCursorPosition = (root, position) => {
  if (!position) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = position.offset;
  let node;

  while ((node = walker.nextNode())) {
    const length = node.textContent?.length || 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      break;
    }
    remaining -= length;
  }
};

/**
 * Wire up the editable field with lightweight change tracking.
 * @param {HTMLElement | null} root
 */
const bootstrapEditor = (root) => {
  if (!root) return;
  let documentState = createDocumentState();

  root.addEventListener('beforeinput', (event) => {
    event.preventDefault();
    const cursorPosition = saveCursorPosition(root);

    if (event.inputType === 'insertText' && event.data) {
      documentState = applyEdit(documentState, { type: 'appendChar', char: event.data });
    } else if (event.inputType === 'deleteContentBackward') {
      documentState = applyEdit(documentState, { type: 'deleteChar' });
    } else {
      console.warn('event not yet handled:');
      console.warn(JSON.stringify(event));
    }

    root.replaceChildren(...markdownToHtml(documentState.content));
    restoreCursorPosition(root, cursorPosition);
  });

  root.replaceChildren(...markdownToHtml(documentState.content));

  console.log(JSON.stringify(documentState));
};

bootstrapEditor(document.querySelector('main'));
