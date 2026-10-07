/**
 * Fixed synthetic capability probe shared by the server-side credential test and the
 * extension's "Test connection" button. It must never carry collection, bookmark, tag
 * or credential data, and both sides assert the same bounded answer shape.
 */
export const CLASSIFICATION_PROBE_INPUT = Object.freeze({
  state: {subject: 'alpha'},
  questions: {
    folder: {type: 'choice', instructions: 'Choose alpha.', criteria: {alpha: 'alpha', beta: 'beta'}},
    tag: {type: 'noul', instructions: 'Is the subject alpha?', criteria: {true: 'alpha', false: 'not alpha'}},
  },
});

export const CLASSIFICATION_PROBE_OPTIONS = Object.freeze(['alpha', 'beta']);
