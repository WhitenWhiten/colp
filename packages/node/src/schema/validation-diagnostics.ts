/** Counters for tests that prove snapshot work was skipped. Not a public package export. */
export const schemaValidationDiagnostics = {
  boundaryWalks: 0,
  boundaryReuses: 0,
  uniqueWalks: 0,
  uniqueReuses: 0,
  reset(): void {
    this.boundaryWalks = 0;
    this.boundaryReuses = 0;
    this.uniqueWalks = 0;
    this.uniqueReuses = 0;
  },
};
