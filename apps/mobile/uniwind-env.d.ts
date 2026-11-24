// What the typecheck needs to know about the app's styles (global.css, uniwind):
// - the className props uniwind adds to React Native's components (View, Text,
//   Pressable, TextInput, ScrollView...) and their color props (placeholder,
//   cursor, selection), from uniwind/types;
// - that global.css is a module (src/app.tsx imports it for its effect), as
//   Expo's own types say.
// uniwind's declaration of its theme names is written by Metro outside the tree
// (metro.config.js); uniwind-themes.d.ts is the typecheck's copy of it.
/// <reference types="uniwind/types" />

declare module '*.css';
