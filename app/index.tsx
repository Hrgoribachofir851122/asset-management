/**
 * app/index.tsx — Root route "/" of the standalone app.
 *
 * The original Pampi project had this redirector (it was not part of the
 * wallet-section files that were carried over). Without it the cold-start
 * URL "/" matches no screen and expo-router renders +not-found.
 *
 * v1.6.0 — THIS was the real reason the app still opened on «مدیریت دارایی»:
 * the cold-start URL "/" hits THIS file first and redirected to /wallet
 * before initialRouteName of the tabs layout could ever apply. The redirect
 * now points to the prices tab (user request: app always opens on «قیمت‌ها»).
 * Together with initialRouteName="prices/index" in app/(tabs)/_layout.tsx
 * the open-on-prices behaviour is now enforced on two independent layers.
 */

import { Redirect } from 'expo-router';
import React from 'react';

export default function Index() {
  return <Redirect href="/prices" />;
}
