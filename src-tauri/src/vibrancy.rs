//! Native sidebar vibrancy.
//!
//! On macOS the main window is created transparent (`tauri.macos.conf.json`)
//! and an `NSVisualEffectView` with the sidebar material is placed behind the
//! webview. The frontend then makes only the window frame and the sidebar
//! transparent (`native-vibrancy` class); every reading surface stays solid.
//! Windows and Linux never get the effect and keep the solid sidebar.

use std::sync::atomic::{AtomicBool, Ordering};

/// The only window created transparent; pop-outs and the splash stay opaque.
pub const VIBRANT_WINDOW_LABEL: &str = "main";

/// Whether this build can show native vibrancy at all.
pub const PLATFORM_SUPPORTS_VIBRANCY: bool = cfg!(target_os = "macos");

/// Records whether the effect was applied to the main window at startup.
#[derive(Default)]
pub struct VibrancyState(AtomicBool);

impl VibrancyState {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn set_applied(&self, applied: bool) {
        self.0.store(applied, Ordering::Relaxed);
    }

    pub fn applied(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// A window shows vibrancy only if it is the transparent main window, the
/// platform supports it and the effect was actually applied.
pub fn is_vibrant(label: &str, platform_supported: bool, applied: bool) -> bool {
    platform_supported && applied && label == VIBRANT_WINDOW_LABEL
}

/// Applies the sidebar material behind the main window's webview.
#[cfg(target_os = "macos")]
pub fn apply<R: tauri::Runtime>(app: &tauri::App<R>) -> bool {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    use tauri::Manager;

    let Some(window) = app.get_webview_window(VIBRANT_WINDOW_LABEL) else {
        return false;
    };
    let effects = EffectsBuilder::new()
        .effect(Effect::Sidebar)
        .state(EffectState::FollowsWindowActiveState)
        .build();
    match window.set_effects(effects) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("Failed to apply sidebar vibrancy: {e}");
            false
        }
    }
}

/// Lets the calling window know whether to make its frame and sidebar transparent.
#[tauri::command]
pub fn native_vibrancy_active(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, VibrancyState>,
) -> bool {
    is_vibrant(window.label(), PLATFORM_SUPPORTS_VIBRANCY, state.applied())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const BASE_CONFIG: &str = include_str!("../tauri.conf.json");
    const MACOS_CONFIG: &str = include_str!("../tauri.macos.conf.json");

    fn windows(config: &str) -> Vec<Value> {
        let json: Value = serde_json::from_str(config).expect("config is valid JSON");
        json["app"]["windows"]
            .as_array()
            .expect("config lists app.windows")
            .clone()
    }

    fn window<'a>(windows: &'a [Value], label: &str) -> &'a Value {
        windows
            .iter()
            .find(|w| w["label"] == label)
            .unwrap_or_else(|| panic!("window {label} is configured"))
    }

    #[test]
    fn only_the_main_window_is_vibrant() {
        assert!(is_vibrant("main", true, true));
        assert!(!is_vibrant("thread-abc", true, true));
        assert!(!is_vibrant("compose-1", true, true));
        assert!(!is_vibrant("splashscreen", true, true));
    }

    #[test]
    fn no_vibrancy_when_the_effect_failed_or_platform_lacks_it() {
        assert!(!is_vibrant("main", true, false));
        assert!(!is_vibrant("main", false, true));
    }

    #[test]
    fn platform_support_is_macos_only() {
        assert_eq!(PLATFORM_SUPPORTS_VIBRANCY, cfg!(target_os = "macos"));
        let state = VibrancyState::default();
        assert!(!state.applied());
        state.set_applied(true);
        assert!(state.applied());
    }

    #[test]
    fn base_config_keeps_every_window_opaque() {
        for w in windows(BASE_CONFIG) {
            assert_ne!(w["transparent"], Value::Bool(true), "{} is opaque", w["label"]);
        }
    }

    #[test]
    fn macos_config_makes_only_the_main_window_transparent() {
        let mac = windows(MACOS_CONFIG);
        assert_eq!(window(&mac, "main")["transparent"], Value::Bool(true));
        for w in mac.iter().filter(|w| w["label"] != "main") {
            assert_ne!(w["transparent"], Value::Bool(true), "{} is opaque", w["label"]);
        }
    }

    /// JSON merge patch replaces the whole windows array, so the macOS file
    /// repeats it; it must differ from the base only by `transparent`.
    #[test]
    fn macos_windows_match_the_base_apart_from_transparency() {
        let strip = |mut ws: Vec<Value>| {
            for w in &mut ws {
                w.as_object_mut().unwrap().remove("transparent");
            }
            ws
        };
        assert_eq!(strip(windows(MACOS_CONFIG)), strip(windows(BASE_CONFIG)));
    }

    #[test]
    fn private_api_is_enabled_for_the_transparent_webview() {
        let json: Value = serde_json::from_str(BASE_CONFIG).unwrap();
        assert_eq!(json["app"]["macOSPrivateApi"], Value::Bool(true));
    }
}
