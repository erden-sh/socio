// An image imported by the app (`import mascot from '../../assets/icon-512.png'`):
// Metro bundles it and the import gives its asset id, which React Native's and
// expo-image's `source` take.
declare module '*.png' {
    const asset: number;
    export default asset;
}
