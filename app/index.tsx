/**
 * app/index.tsx — Root route "/" of the standalone app.
 *
 * The original Pampi project had this redirector (it was not part of the
 * wallet-section files that were carried over). Without it the cold-start
 * URL "/" matches no screen and expo-router renders +not-found.
 */

import { Redirect } from 'expo-router';
import React from 'react';

export default function Index() {
  return <Redirect href="/wallet" />;
}
