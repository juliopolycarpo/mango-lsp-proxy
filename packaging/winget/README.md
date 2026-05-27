# Winget Packaging

Release automation writes ready-to-submit winget manifests into the GitHub release asset:

```text
mango-lsp-<version>-winget-manifests.tar.gz
```

The generated package identifier is:

```text
JulioPolycarpo.MangoLSP
```

After a release is created, extract the manifest archive and submit the contained `j/JulioPolycarpo`
tree to `microsoft/winget-pkgs`. The installer manifest uses the release's Windows x64 and ARM64
portable `.exe` assets and their SHA-256 hashes.

Local validation on Windows:

```powershell
winget validate .\j\JulioPolycarpo\MangoLSP\<version>\
winget install --manifest .\j\JulioPolycarpo\MangoLSP\<version>\
```
