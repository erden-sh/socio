// oxlint-disable typescript/no-require-imports -- Expo loads config plugins as CommonJS (../SYNC.md)
const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
  withDangerousMod,
} = require("expo/config-plugins");

// Preserve AppCompat's default 16dp dialog inset.
const DIALOG_BACKGROUND_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:insetLeft="16dp"
    android:insetTop="16dp"
    android:insetRight="16dp"
    android:insetBottom="16dp">
  <shape android:shape="rectangle">
    <solid android:color="@color/alert_dialog_background" />
    <corners android:radius="24dp" />
  </shape>
</inset>
`;

// Socio: the colors come from the plugin's props, { light, night }, each with background, text,
// secondaryText and buttonText, instead of T3 Code's generated uniwind theme.
const PALETTE_KEYS = ["background", "text", "secondaryText", "buttonText"];

function paletteFrom(props, appearance) {
  const palette = props?.[appearance];
  for (const key of PALETTE_KEYS) {
    if (typeof palette?.[key] !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(palette[key])) {
      throw new Error(
        `withAndroidModernAlertDialog: props.${appearance}.${key} must be a #RRGGBB color.`,
      );
    }
  }
  return palette;
}

function assignStyleItem(style, name, value) {
  style.item = style.item ?? [];
  const existing = style.item.find((item) => item.$?.name === name);
  if (existing) {
    existing._ = value;
  } else {
    style.item.push({ _: value, $: { name } });
  }
}

function withAlertDialogStyles(config) {
  return withAndroidStyles(config, (config) => {
    const resources = config.modResults.resources;
    resources.style = resources.style ?? [];

    const appTheme = resources.style.find((style) => style.$?.name === "AppTheme");
    if (appTheme) {
      // React Native uses the AppCompat attr; platform dialogs need the framework attr too.
      assignStyleItem(appTheme, "alertDialogTheme", "@style/AppAlertDialog");
      assignStyleItem(appTheme, "android:alertDialogTheme", "@style/AppAlertDialog");
    }

    resources.style = resources.style.filter(
      (style) =>
        !["AppAlertDialog", "AppAlertDialog.Title", "AppAlertDialog.Button"].includes(
          style.$?.name,
        ),
    );
    resources.style.push(
      {
        $: { name: "AppAlertDialog", parent: "ThemeOverlay.AppCompat.Dialog.Alert" },
        item: [
          { _: "@drawable/alert_dialog_background", $: { name: "android:windowBackground" } },
          { _: "@color/alert_dialog_secondary_text", $: { name: "android:textColorPrimary" } },
          { _: "@color/alert_dialog_secondary_text", $: { name: "android:textColorSecondary" } },
          // Theme fontFamily covers text views without their own font, including the message body.
          { _: "sans-serif", $: { name: "android:fontFamily" } },
          // AppCompat titles use android:windowTitleStyle; there is no unprefixed equivalent.
          { _: "@style/AppAlertDialog.Title", $: { name: "android:windowTitleStyle" } },
          { _: "@style/AppAlertDialog.Button", $: { name: "buttonBarPositiveButtonStyle" } },
          { _: "@style/AppAlertDialog.Button", $: { name: "buttonBarNegativeButtonStyle" } },
          { _: "@style/AppAlertDialog.Button", $: { name: "buttonBarNeutralButtonStyle" } },
        ],
      },
      {
        $: { name: "AppAlertDialog.Title", parent: "RtlOverlay.DialogWindowTitle.AppCompat" },
        item: [
          { _: "sans-serif-medium", $: { name: "android:fontFamily" } },
          { _: "18sp", $: { name: "android:textSize" } },
          { _: "@color/alert_dialog_text", $: { name: "android:textColor" } },
        ],
      },
      {
        $: {
          name: "AppAlertDialog.Button",
          parent: "Widget.AppCompat.Button.ButtonBar.AlertDialog",
        },
        item: [
          // Override AppCompat's hardcoded sans-serif-medium button font.
          { _: "sans-serif-medium", $: { name: "android:fontFamily" } },
          { _: "@color/alert_dialog_button_text", $: { name: "android:textColor" } },
          { _: "false", $: { name: "android:textAllCaps" } },
          { _: "0", $: { name: "android:letterSpacing" } },
        ],
      },
    );

    return config;
  });
}

function assignColors(colorsResource, palette) {
  let result = colorsResource;
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_background",
    value: palette.background,
  });
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_text",
    value: palette.text,
  });
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_secondary_text",
    value: palette.secondaryText,
  });
  result = AndroidConfig.Colors.assignColorValue(result, {
    name: "alert_dialog_button_text",
    value: palette.buttonText,
  });
  return result;
}

function withAlertDialogColors(config, colors) {
  config = withAndroidColors(config, (config) => {
    config.modResults = assignColors(config.modResults, colors.light);
    return config;
  });
  config = withAndroidColorsNight(config, (config) => {
    config.modResults = assignColors(config.modResults, colors.night);
    return config;
  });
  return config;
}

function withAlertDialogBackgroundDrawable(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const drawableDir = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable",
      );
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(
        path.join(drawableDir, "alert_dialog_background.xml"),
        DIALOG_BACKGROUND_DRAWABLE,
      );
      return config;
    },
  ]);
}

module.exports = function withAndroidModernAlertDialog(config, props) {
  const colors = { light: paletteFrom(props, "light"), night: paletteFrom(props, "night") };
  return withAlertDialogBackgroundDrawable(
    withAlertDialogColors(withAlertDialogStyles(config), colors),
  );
};
