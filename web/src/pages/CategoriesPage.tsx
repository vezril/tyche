import { useEffect, useState } from 'react';
import type {
  CategoryStructureResponse,
  ManagedCategory,
  ManagedCategoryGroup,
} from '@tyche/shared';
import { ApiError, apiGet, apiSend, describeError } from '../api.js';

/**
 * Budget-structure management screen (E3.S6, FR-9): create, rename, reorder
 * (keyboard-accessible up/down buttons + cross-group select — no drag
 * required, NFR-9), hide/unhide, and delete for categories and groups.
 *
 * Every mutation answers with the full recomputed structure (mirroring the
 * grid's contract): the server's payload always replaces local state, and
 * `onChanged` lets the shell refresh the pickers/grid feeding off categories
 * (AC-1 "appears immediately").
 *
 * Deleting a category with history is a two-step: the server answers 409
 * `reassignment_required`, and the row grows the required target picker
 * (AC-4) — there is deliberately NO client-side guess about history.
 */

interface RenameDraft {
  kind: 'group' | 'category';
  id: string;
  value: string;
}

interface ReassignDraft {
  categoryId: string;
  targetId: string;
}

export function CategoriesPage({ onChanged }: { onChanged?: () => void }): React.JSX.Element {
  const [structure, setStructure] = useState<CategoryStructureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rename, setRename] = useState<RenameDraft | null>(null);
  const [reassign, setReassign] = useState<ReassignDraft | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newCategoryNames, setNewCategoryNames] = useState<Record<string, string>>({});

  useEffect(() => {
    apiGet<CategoryStructureResponse>('/api/categories/structure')
      .then(setStructure)
      .catch((err: unknown) => setError(describeError(err)));
  }, []);

  const apply = (fresh: CategoryStructureResponse): void => {
    setStructure(fresh);
    setRename(null);
    setReassign(null);
    onChanged?.();
  };

  const mutate = async (
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<void> => {
    setError(null);
    try {
      apply(await apiSend<CategoryStructureResponse>(method, url, body));
    } catch (err) {
      setError(describeError(err));
    }
  };

  const allCategories: ManagedCategory[] = structure?.groups.flatMap((g) => g.categories) ?? [];

  const removeCategory = async (category: ManagedCategory): Promise<void> => {
    setError(null);
    try {
      apply(await apiSend<CategoryStructureResponse>('DELETE', `/api/categories/${category.id}`));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reassignment_required') {
        // AC-4: history exists — the server demands a target before deletion.
        const firstOther = allCategories.find((c) => c.id !== category.id);
        setReassign({ categoryId: category.id, targetId: firstOther?.id ?? '' });
      } else {
        setError(describeError(err));
      }
    }
  };

  const renameEditor = (kind: 'group' | 'category', id: string, name: string): React.JSX.Element =>
    rename?.kind === kind && rename.id === id ? (
      <input
        aria-label={`Rename ${name}`}
        autoFocus
        value={rename.value}
        onChange={(e) => setRename({ kind, id, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void mutate(
              'PATCH',
              kind === 'group' ? `/api/category-groups/${id}` : `/api/categories/${id}`,
              { name: rename.value },
            );
          } else if (e.key === 'Escape') {
            setRename(null);
          }
        }}
      />
    ) : (
      <>
        <span className="manage-name">{name}</span>
        <button
          type="button"
          aria-label={`Rename ${name}`}
          onClick={() => setRename({ kind, id, value: name })}
        >
          Rename
        </button>
      </>
    );

  const categoryRow = (
    group: ManagedCategoryGroup,
    category: ManagedCategory,
    index: number,
  ): React.JSX.Element => (
    <li key={category.id} className={`manage-category${category.hidden ? ' is-hidden' : ''}`}>
      <span className="manage-row">
        {renameEditor('category', category.id, category.name)}
        {category.hidden && <span className="hidden-badge">(hidden)</span>}
        <span className="manage-actions">
          <button
            type="button"
            aria-label={`Move ${category.name} up`}
            disabled={index === 0}
            onClick={() => void mutate('PATCH', `/api/categories/${category.id}`, { index: index - 1 })}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${category.name} down`}
            disabled={index === group.categories.length - 1}
            onClick={() => void mutate('PATCH', `/api/categories/${category.id}`, { index: index + 1 })}
          >
            ↓
          </button>
          <select
            aria-label={`Move ${category.name} to group`}
            value={group.id}
            onChange={(e) => {
              if (e.target.value !== group.id) {
                void mutate('PATCH', `/api/categories/${category.id}`, { groupId: e.target.value });
              }
            }}
          >
            {structure!.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              void mutate('PATCH', `/api/categories/${category.id}`, { hidden: !category.hidden })
            }
            aria-label={`${category.hidden ? 'Unhide' : 'Hide'} ${category.name}`}
          >
            {category.hidden ? 'Unhide' : 'Hide'}
          </button>
          <button
            type="button"
            aria-label={`Delete ${category.name}`}
            onClick={() => void removeCategory(category)}
          >
            Delete
          </button>
        </span>
      </span>
      {reassign?.categoryId === category.id && (
        <span className="manage-reassign">
          <label>
            Reassign {category.name} history to
            <select
              aria-label={`Reassign ${category.name} history to`}
              value={reassign.targetId}
              onChange={(e) => setReassign({ categoryId: category.id, targetId: e.target.value })}
            >
              {allCategories
                .filter((c) => c.id !== category.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              void mutate(
                'DELETE',
                `/api/categories/${category.id}?reassignTo=${encodeURIComponent(reassign.targetId)}`,
              )
            }
          >
            Reassign and delete
          </button>
          <button type="button" onClick={() => setReassign(null)}>
            Cancel
          </button>
        </span>
      )}
    </li>
  );

  return (
    <section className="manage" aria-label="Manage categories">
      <h1>Categories</h1>
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {structure?.groups.map((group, groupIndex) => (
        <section key={group.id} className={`manage-group${group.hidden ? ' is-hidden' : ''}`}>
          <h2 className="manage-row">
            {renameEditor('group', group.id, group.name)}
            {group.hidden && <span className="hidden-badge">(hidden)</span>}
            <span className="manage-actions">
              <button
                type="button"
                aria-label={`Move ${group.name} up`}
                disabled={groupIndex === 0}
                onClick={() =>
                  void mutate('PATCH', `/api/category-groups/${group.id}`, { index: groupIndex - 1 })
                }
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${group.name} down`}
                disabled={groupIndex === structure.groups.length - 1}
                onClick={() =>
                  void mutate('PATCH', `/api/category-groups/${group.id}`, { index: groupIndex + 1 })
                }
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() =>
                  void mutate('PATCH', `/api/category-groups/${group.id}`, { hidden: !group.hidden })
                }
                aria-label={`${group.hidden ? 'Unhide' : 'Hide'} ${group.name}`}
              >
                {group.hidden ? 'Unhide' : 'Hide'}
              </button>
              <button
                type="button"
                aria-label={`Delete ${group.name}`}
                onClick={() => void mutate('DELETE', `/api/category-groups/${group.id}`)}
              >
                Delete
              </button>
            </span>
          </h2>
          <ul className="manage-list">
            {group.categories.map((category, index) => categoryRow(group, category, index))}
          </ul>
          <form
            className="manage-add"
            onSubmit={(e) => {
              e.preventDefault();
              const name = (newCategoryNames[group.id] ?? '').trim();
              if (name === '') return;
              setNewCategoryNames((n) => ({ ...n, [group.id]: '' }));
              void mutate('POST', '/api/categories', { groupId: group.id, name });
            }}
          >
            <input
              aria-label={`New category in ${group.name}`}
              placeholder="New category"
              value={newCategoryNames[group.id] ?? ''}
              onChange={(e) => setNewCategoryNames((n) => ({ ...n, [group.id]: e.target.value }))}
            />
            <button type="submit">Add category to {group.name}</button>
          </form>
        </section>
      ))}
      {structure && (
        <form
          className="manage-add"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newGroupName.trim();
            if (name === '') return;
            setNewGroupName('');
            void mutate('POST', '/api/category-groups', { name });
          }}
        >
          <input
            aria-label="New group name"
            placeholder="New group"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
          />
          <button type="submit">Add group</button>
        </form>
      )}
    </section>
  );
}
