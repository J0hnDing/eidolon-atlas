# Core model

Eidolon-Atlas models one person's information as typed records connected by
links. It is not a generic knowledge tree. Each record has one category, a
category-specific encrypted payload, an optimistic revision, and optional
custom fields.

## Categories

### Person

There is at most one Person record: the atlas owner's profile. It holds their
name, summary, repeatable contact methods, languages, nationalities, address
information, and profile notes. Sensitive government identifiers are
kept in a collapsed section rather than mixed into the everyday profile. Dates
can be included where their history matters. Other people and organizations
belong in Relationships.

### Experience

An Experience is an event or period on the owner's timeline. Dates may be a
year, year and month, or complete date so the user never has to invent
precision. Experiences can be ongoing and link to any other record. Experiences
may also carry encrypted JPEG, PNG, or WebP images, up to 20 MiB per image and
50 images per Experience.

### Goal

A Goal has a short-, middle-, or long-term horizon and a lifecycle status.
Goals form an ordered parent/subgoal tree. A goal has at most one parent;
cycles are invalid; sibling order is explicit. This hierarchy is separate from
ordinary cross-record links.

### Project

A Project preserves context, dates, outcome, status, and a brief current-state
note. Atlas does not provide project tasks, milestones, assignments, or
workflow automation.

### Resource

A Resource records something the owner has or can access, including wealth,
capital, assets, liabilities, accounts, and capabilities. Resources are an
inventory, not a financial ledger: v1 stores no valuations or transactions.

### Relationships

A Relationship represents another person or organization together with the
owner's relationship type, status, importance, dates, contact details, and
notes. Shared experiences and projects are ordinary links.

### Preference

A Preference records a contextual inclination: its domain, statement,
strength, rationale, and optional effective dates.

## Links and custom fields

Links connect two records and carry a user-defined type and optional note.
They are navigable in both directions but do not change category ownership or
goal parentage.

Each category can define custom fields of type text, long text, number,
Boolean, date, URL, or single choice. A definition with stored values is
archived rather than destroyed.

## Revisions and trash

Every meaningful mutation creates an immutable revision. Restoring an older
revision creates a new current revision; history is never rewritten. No-op
edits do not create revisions.

Trashing is reversible. A goal with active subgoals cannot be trashed until
those children are moved or trashed. Links remain associated with a trashed
record and become visible again if it is restored.

Experience attachments are independent of record revisions: adding or removing
an image does not create a record revision. Attachments remain available while
their Experience is in trash and return when it is restored.

## Navigation

Experience, Goal, Project, Resource, and Relationship records open on routed
full-page detail views. Person and Preference records continue to use the
workspace drawer.

## Dates

User-entered dates accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. An end date must
not precede a start date at the same available precision. Empty dates mean
unknown, not present time; ongoing state is explicit.
