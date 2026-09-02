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

## Wealthflow migration checklist

- [ ] Record the packed core/protocol tarball SHA-256 values used by wealthflow.
- [ ] Install only those tarballs; use no AgentLink source paths or aliases.
- [ ] Adapt wealthflow's OpenAI-compatible endpoint and app-owned credential resolver.
- [ ] Map wealthflow domain tools to `defineTool`, including mutation/effect metadata.
- [ ] Require signed durable approval resume for mutating tools.
- [ ] Supply wealthflow-owned session and lease adapters and run the host-adapter contracts.
- [ ] Verify streaming, cancellation, bounded execution, and process-recreated engine requests.
- [ ] Keep wealthflow web research tools host-owned and MCP client support disabled.
- [ ] Document rollback to the previous wealthflow agent implementation.

This fixture proves the packed SDK boundary and synthetic non-MCP runtime path. It does not claim that wealthflow itself has migrated, that production storage adapters exist here, or that E7 MCP is complete.
