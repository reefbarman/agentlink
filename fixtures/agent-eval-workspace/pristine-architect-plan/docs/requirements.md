# Requirements

The notes app currently stores notes in memory. We want to add tag support without changing the storage backend yet.

Constraints:

- Keep existing note creation behavior compatible.
- Tags should be normalized to lowercase.
- Empty tags should be ignored.
- The first implementation should include tests.
- Do not introduce a database or external dependency.
