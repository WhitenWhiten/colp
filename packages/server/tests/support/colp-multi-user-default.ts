// Inherited auth suites create more than one user in a single schema.
// Outside tests, registration closes after the first auth_users row unless
// COLP_MULTI_USER=true. Default the suite to that switch so the G2 gate does
// not refuse those sign-ups. Tests that cover the closed gate opt out.
if (process.env.COLP_MULTI_USER === undefined) {
  process.env.COLP_MULTI_USER = 'true';
}
