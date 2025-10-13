// @ts-check

import './style.css';

/**
 * Wire up the editable field with lightweight change tracking.
 * @param {HTMLElement | null} root
 */
const bootstrapEditor = (root) => {
  if (!root) return;
  
  let firstParagraph = document.createElement("p");
  firstParagraph.textContent = "A distraction free writing tool.";

  let secondParagraph = document.createElement("p");
  secondParagraph.textContent = "So it goes.";

  root.replaceChildren(firstParagraph, secondParagraph);
};

bootstrapEditor(document.querySelector('main'));
