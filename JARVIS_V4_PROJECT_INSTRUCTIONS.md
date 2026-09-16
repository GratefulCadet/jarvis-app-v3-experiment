# JARVIS V4 Project Instructions

This is the Electron project's clone-portable project instruction for the current JARVIS V4 interaction / UX redesign phase. The full canonical contracts are maintained in the Harness repository; this file preserves the binding V4 direction here without copying those long documents.

## Binding direction

- **Assistant-first:** JARVIS itself is the product and primary entry. Typed input, voice, PiP, fullscreen, and future invocation methods converge on the same runtime; users should not choose a subsystem or mode before useful interaction.
- **Workspace-grounded, not File-Explorer-first:** real approved Workspace/filesystem context grounds JARVIS, while JARVIS remains the primary interaction layer. `Project != Folder`.
- **Focus-on-demand:** execution is primarily a state or transient Focus Session, not automatically a permanent top-level surface.
- **Prototype boundaries:** the SYSTEM / EXECUTION split and TreePrototype are not binding permanent architecture. CommandCenter contains both core assistant interaction and historical focus/execution UI; do not preserve or remove it as one indivisible unit automatically.
- **User-facing ontology:** `Goal → Project → Task → Next Action → Execution` is a historical hypothesis, not binding. Do not invent persistent Goal, Next Action, or Focus schemas without explicit approval.
- **Core capabilities:** Qwen, Voice/STT/TTS, approval, and permission behavior are core JARVIS capabilities and must use the same runtime safety boundary.
- **Context:** Workspace, File, Task, and Page surfaces primarily provide inspectable context to JARVIS; they must not become mandatory navigation-first subsystems.
- **PiP:** keep it important for presence, invocation, state, approval, and high-value interruption, but do not create ambient noise without useful value.
- **Stable infrastructure:** preserve the Qwen → Harness → Tools boundary, runtime identity contracts, WorkspaceRoot, FileRef, Task/Page identity, canonical Task CRUD, permission principles, and read-oriented filesystem boundaries.
- **Paused work:** Task→Page ResourceLink V1, broad relationship expansion, semantic/vector search, embeddings, SQLite migration, LoRA/Soup, broad Page CRUD, autonomous filesystem writes, and broad Project/Goal ontology expansion require a new explicit decision.

## Current phase and working rules

**Current phase: JARVIS V4 INTERACTION / UX REDESIGN.**

Inspect actual current interaction and code before changes. Use one bounded hypothesis per pass. Preserve stable backend/runtime contracts. Do not treat this instruction as proof that target behavior is implemented. Do not automatically select the next milestone, continue paused work, or begin implementation without an explicit request.
