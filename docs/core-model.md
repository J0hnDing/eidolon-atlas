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

A Goal has a short-, middle-, or long-term horizon, an optional target date,
and a description. Every goal and subgoal has an importance of `low`, `medium`,
or `high`; existing and new records default to `medium`. Top-level goal creation does not ask for progress; subgoals
start at a user-selected progress value that defaults to zero. Parent progress
rolls up from subgoals, and subgoal ownership and order are assigned by the
progression that creates them.
Goals form an ordered parent/subgoal hierarchy. Within each goal, its direct
subgoals can declare other sibling subgoals as prerequisites, producing a
directed acyclic progression graph whose terminal steps lead to the parent
goal. A goal has at most one parent; hierarchy and prerequisite cycles are
invalid; sibling order is explicit. Each leaf goal stores progress from 0 to
100, while parent progress rolls up evenly from its active direct subgoals.
This progression is separate from ordinary cross-record links.
Dedicated subgoal creation stores the new Goal and all selected sibling
prerequisite edges in one transaction. A client-generated request UUID makes a
retry return the original subgoal instead of creating a duplicate.

### Knowledge

Knowledge is the Epistome-style taxonomy workspace. Nodes belong to a branch,
have one canonical parent, a status, and revision timestamps. Names,
explanations, and terms are encrypted payload; branch, parentage, status,
revision, timestamps, and connection topology are structural metadata. Sibling
names are case-insensitively unique, parents must be known, cycles are
rejected, and only leaf nodes may be deleted. Connections are undirected.
Knowledge is included in encrypted Atlas backups and is available at
`/knowledge` in the browser.

### Project

A Project preserves context, a lifecycle status (planned, active, paused,
completed, or abandoned), and an optional GitHub link. Atlas does not provide
project tasks, milestones, assignments, or workflow automation.

### Resource

A Resource records something the owner has or can access, including wealth,
capital, assets, liabilities, accounts, and capabilities. Resources are an
inventory, not a financial ledger: v1 stores no valuations or transactions.

### Relationships

A Relationship belongs to one predefined category: Family, Partner/Spouse,
Friends, Acquaintances, Coworkers, Mentors, or Organizations. It records the
owner's relationship type, status, importance, dates, contact details, and
notes. Shared experiences and projects are ordinary links. The Relationships
landing page presents these categories before opening an individual category.

### Interest

Interest is the top-level workspace for Hobbies and Preferences. Every
Interest record has a required `kind` of `hobby` or `preference`.

A Hobby uses its title as a concise name and may include a description,
engagement (`casual`, `regular`, `serious`, or `past`), self-assessed skill
level (`beginner`, `intermediate`, `advanced`, or `expert`), a partial `started`
date, and notes about equipment, routines, communities, goals, or other useful
context. The engagement, skill level, and start date are optional.

A Preference keeps its existing semantics: it records a contextual inclination
through its domain, preferred value, strength, context, rationale, and optional
effective dates.

## Links and custom fields

Links connect two records and carry a user-defined type and optional note.
They are navigable in both directions but do not change category ownership or
goal parentage.

Each category can define custom fields of type text, long text, number,
Boolean, date, URL, or single choice. Deleting a custom field permanently
removes its definition and all of its values from current and historical
record snapshots.

## Revisions and trash

Ordinary record mutations create immutable revisions. Restoring an older
revision creates a new current revision; no-op edits do not create revisions.
Permanently deleting a custom field is the explicit exception: its values are
purged from every revision so the deleted field does not survive in history.

Trashing is reversible. A goal with active subgoals cannot be trashed until
those children are moved or trashed. Links remain associated with a trashed
record and become visible again if it is restored.

Cleaning up Recently Removed permanently deletes every trashed record together
with its revision history, links, and attachments. This cannot be undone.

Experience attachments are independent of record revisions: adding or removing
an image does not create a record revision. Attachments remain available while
their Experience is in trash and return when it is restored.

## Navigation

Experience, Goal, Project, Resource, and Relationship records open on routed
full-page detail views. Person and Interest records continue to use the
workspace drawer.

## Dates

User-entered dates accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. An end date must
not precede a start date at the same available precision. Empty dates mean
unknown, not present time; ongoing state is explicit.
