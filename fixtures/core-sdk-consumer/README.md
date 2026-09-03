# Packed Core SDK Consumer — E8

Run the isolated package-boundary proof from the repository root:

```sh
npm run test:core-sdk-consumer
```

Vendor a matched SDK set into a real consumer with:

```sh
npm run vendor:core-sdk -- --destination /path/to/consumer/vendor/agentlink
```

Add `--include-node-host` when needed. The command emits content-addressed tarballs plus `agentlink-sdk-artifacts.json`, validates exact transitive AgentLink versions, and clean-installs/imports the emitted set with a disposable npm cache. Copy the manifest's `packageJsonDependencies` into the consumer manifest and commit the artifacts, manifest, package manifest, and regenerated lockfile together.

## Automated acceptance checklist

- [x] Build and `npm pack` `@agentlink/protocol`, `@agentlink/core`, and `@agentlink/node-host`.
- [x] Install all three tarballs outside the repository and its `node_modules` ancestry with exact local dependency overrides.
- [x] Type-check and runtime-load every packed core export path under ESM and CommonJS without source aliases.
- [x] Run a Node consumer with one provider-qualified catalog model.
- [x] Exercise hard-coded and catalog-driven model selection.
- [x] Execute two schema-defined, principal-scoped host tools.
- [x] Stream turns through shared session/lease stores for two tenants.
- [x] Continue a session with a newly created engine instance.
- [x] Cancel a turn and persist its terminal state.
- [x] Reject every `@agentlink/core` export under explicit browser and Edge package conditions.
- [x] Positively bundle `@agentlink/protocol/model-catalog` for the browser.
- [x] Verify installed package resolution stays inside the isolated consumer's own `node_modules`.
- [x] Run one host-authorized remote Streamable HTTP MCP tool through `@agentlink/node-host` and the core turn loop.
- [x] Require HTTPS, authorize every transport request, reject redirects, and prove a denied destination performs no underlying fetch.
- [x] Reject invocation when a discovered remote tool is reused by another principal/session/turn.

## WealthFlow migration checklist

- [x] Record the packed artifacts: core SHA-256 `665ac3df22e8dcbec40a9c8f91b2d6b6234514b46b01b375d65944add74537d0`; protocol SHA-256 `038c249d1193591d15d7207de6d7803689ae1f10e6b3f7cb39b88c2bae221011`.
- [x] Install only those content-addressed tarballs; use no AgentLink source paths or aliases.
- [x] Adapt WealthFlow's OpenAI-compatible endpoint and app-owned credential resolver.
- [x] Map WealthFlow domain tools to `defineTool`, including mutation/effect metadata and input-side JSON Schema export for transformed Zod schemas.
- [x] Require signed, single-use durable approval resume for mutating tools.
- [x] Supply WealthFlow-owned file-backed session, interaction, and lease adapters with CAS, fencing, atomic writes, and an inter-process state lock.
- [x] Verify streaming, cancellation, bounded execution, and process-recreated engine requests through focused tests and the production build.
- [x] Keep WealthFlow web research tools host-owned and MCP client support disabled.
- [x] Document package-pair rollback in [`packages/core/README.md`](../../packages/core/README.md).
- [ ] Re-vendor with `npm run vendor:core-sdk`, copy `vendor/agentlink` before dependency installation in every Docker/add-on build, and prove a clean deployment with no pre-existing `node_modules`.

This fixture preserves the E8a synthetic non-MCP runtime proof and completes full E8 with a packed Node-host remote-MCP path. WealthFlow remains an external integration under validation, not yet production proof; its clean packaging, privacy, lifecycle, event handling, and approval integration gates still need to pass.
