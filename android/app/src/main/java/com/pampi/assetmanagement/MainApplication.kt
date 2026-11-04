package com.pampi.assetmanagement

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
              // v1.3.8 — ماژول «اعلان رشد/ریزش قیمت» (تنظیمات + اعلان آزمایشی + بررسی فوری)
              add(PriceAlertPackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // v1.4.0 — اگر کاربر اعلان را روشن کرده باشد، کارگر دوره‌ای از همان لانچ
    // برنامه زمان‌بندی می‌شود (نگهبان اضافه در کنار زمان‌بندی configure/Boot)
    if (PriceAlertPrefs.isEnabled(this)) {
      try { PriceAlertWorker.schedulePeriodic(this) } catch (_: Exception) {}
    }
    // v1.8.0 — اعلان «نسخهٔ جدید» حتی با برنامهٔ بسته: کارگر چک بروزرسانی
    // همیشه زمان‌بندی می‌شود (مستقل از اعلان قیمت؛ برای همهٔ کاربرها) +
    // یک چک فوری در همین بازشدن برنامه.
    try { UpdateCheckWorker.schedulePeriodic(this) } catch (_: Exception) {}
    try { UpdateCheckWorker.armOnOpen(this) } catch (_: Exception) {}
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
