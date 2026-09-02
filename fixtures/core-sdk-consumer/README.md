# Packed Core SDK Consumer — E8a v1

Run from the repository root:

```sh
npm run test:core-sdk-consumer
```

## Automated acceptance checklist

- [x] Build and `npm pack` `@agentlink/protocol` and `@agentlink/core`.
- [x] Install both tarballs outside the repository and its `node_modules` ancestry.
- [x] Type-check and runtime-load all 21 packed core export paths under ESM and CommonJS without source aliases.
- [x] Run a Node consumer with one provider-qualified catalog model.
- [x] Exercise hard-coded and catalog-driven model selection.
- [x] Execute two schema-defined, principal-scoped host tools.
- [x] Stream turns through shared session/lease stores for two tenants.
- [x] Continue a session with a newly created engine instance.
- [x] Cancel a turn and persist its terminal state.
- [x] Reject every `@agentlink/core` export under explicit browser and Edge package conditions.
- [x] Positively bundle `@agentlink/protocol/model-catalog` for the browser.
- [x] Verify installed package resolution stays inside the isolated consumer's own `node_modules`.
- [x] Keep MCP absent from the fixture.

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

This fixture proves the packed SDK boundary and synthetic non-MCP runtime path. WealthFlow is the completed non-MCP external consumer; E7 remote MCP acceptance remains deferred to Phase C/C3.
