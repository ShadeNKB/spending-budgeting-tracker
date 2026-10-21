Self-hosted fonts for SpendTrack
================================

These files are served from /fonts/ and precached by the service worker, so the
app renders in its own typefaces offline and never contacts a third-party font
host. They are declared with @font-face in src/index.css (font-display: swap,
latin unicode-range; other scripts fall back per glyph to the system font).

Source (vendored with `npm pack`, unchanged; never installed as a dependency):

  @fontsource/ibm-plex-sans@5.3.0
    integrity sha512-CbE4CbbEEZJX860XyUiRpsksXIQR8Rp2XDva2VO53NJox9tVNtusrysd2x5YkUEY3ErQ66W1IiiQL8/wihhw5w==
    files/ibm-plex-sans-latin-400-normal.woff2
    files/ibm-plex-sans-latin-500-normal.woff2
    files/ibm-plex-sans-latin-600-normal.woff2
    files/ibm-plex-sans-latin-700-normal.woff2
    LICENSE -> LICENSE-ibm-plex-sans.txt

  @fontsource/jetbrains-mono@5.3.0
    integrity sha512-fqDfB5I9f1p1TV486aUgB9t8zP84P0O1FtQR5Ol9vjwPy+S+EIGlVYm1cvj2W5shcZMTg2nZFdVMoH5wFu8a1A==
    files/jetbrains-mono-latin-400-normal.woff2
    files/jetbrains-mono-latin-500-normal.woff2
    files/jetbrains-mono-latin-600-normal.woff2
    files/jetbrains-mono-latin-700-normal.woff2
    LICENSE -> LICENSE-jetbrains-mono.txt

Licence: both families are under the SIL Open Font License, Version 1.1
(see the two LICENSE files in this folder).

To update: `npm pack @fontsource/<family>@<version>` into an empty folder,
check the tarball integrity against `npm view @fontsource/<family>@<version>
dist.integrity`, copy the same eight latin normal woff2 files and the LICENSE
files here, and update this README. The unit test
src/__tests__/platform-contract.test.ts checks that every @font-face url and
font preload in index.html points at a real woff2 file in this folder.
