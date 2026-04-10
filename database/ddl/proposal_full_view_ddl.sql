  CREATE OR REPLACE VIEW roadmap.v_proposal_full AS
  WITH
    ac_agg AS (
      SELECT
        proposal_id,
        jsonb_agg(
          jsonb_build_object(
            'item',    item_number,
            'text',    criterion_text,
            'status',  status,
            'by',      verified_by,
            'notes',   verification_notes,
            'at',      verified_at
          ) ORDER BY item_number
        ) AS items,
        COUNT(*)                                     AS total,
        COUNT(*) FILTER (WHERE status = 'pass')      AS passed,
        COUNT(*) FILTER (WHERE status = 'fail')      AS failed,
        COUNT(*) FILTER (WHERE status = 'pending')   AS pending
      FROM roadmap.proposal_acceptance_criteria
      GROUP BY proposal_id
    ),
    deps_agg AS (
      SELECT
        d.from_proposal_id AS proposal_id,
        jsonb_agg(
          jsonb_build_object(
            'type',     d.dependency_type,
            'id',       p2.display_id,
            'title',    p2.title,
            'status',   p2.status,
            'maturity', p2.maturity,
            'resolved', d.resolved
          ) ORDER BY p2.display_id
        ) AS items
      FROM roadmap.proposal_dependencies d
      JOIN roadmap.proposal p2 ON p2.id = d.to_proposal_id
      GROUP BY d.from_proposal_id
    ),
    disc_agg AS (
      SELECT
        proposal_id,
        jsonb_agg(
          jsonb_build_object(
            'id',     id,
            'author', author_identity,
            'prefix', context_prefix,
            'body',   body,
            'at',     created_at
          ) ORDER BY created_at
        ) AS items
      FROM roadmap.proposal_discussions
      WHERE parent_id IS NULL
      GROUP BY proposal_id
    ),
    review_agg AS (
      SELECT
        proposal_id,
        jsonb_agg(
          jsonb_build_object(
            'reviewer', reviewer_identity,
            'verdict',  verdict,
            'notes',    notes,
            'blocking', is_blocking,
            'at',       reviewed_at
          ) ORDER BY reviewed_at
        ) AS items,
        bool_or(verdict = 'approve')                        AS any_approve,
        bool_or(verdict = 'reject' AND is_blocking = true)  AS has_blocker
      FROM roadmap.proposal_reviews
      GROUP BY proposal_id
    ),
    timeline_agg AS (
      SELECT
        proposal_id,
        jsonb_agg(
          jsonb_build_object(
            'from',   from_state,
            'to',     to_state,
            'reason', transition_reason,
            'by',     transitioned_by,
            'notes',  notes,
            'at',     transitioned_at
          ) ORDER BY transitioned_at
        ) AS items
      FROM roadmap.proposal_state_transitions
      GROUP BY proposal_id
    )
  SELECT
    p.id,
    p.display_id,
    p.type,
    p.status,
    p.maturity,                          -- keep until migration complete
    p.priority,
    p.tags,
    p.created_at,
    p.modified_at,
    -- Flat columns for fast filtering
    COALESCE(ac.total,  0)::int AS ac_total,
    COALESCE(ac.passed, 0)::int AS ac_passed,
    COALESCE(ac.failed, 0)::int AS ac_failed,
    COALESCE(rev.any_approve, false)  AS review_approved,
    COALESCE(rev.has_blocker,  false) AS review_blocked,
    -- Full document for markdown rendering
    jsonb_build_object(
      'meta', jsonb_build_object(
        'id',          p.display_id,
        'type',        p.type,
        'status',      p.status,
        'maturity',    p.maturity,
        'priority',    p.priority,
        'tags',        COALESCE(p.tags, '[]'::jsonb),
        'parent',      par.display_id,
        'created_at',  p.created_at,
        'modified_at', p.modified_at,
        'ac_summary',  jsonb_build_object(
          'total',   COALESCE(ac.total,   0),
          'passed',  COALESCE(ac.passed,  0),
          'failed',  COALESCE(ac.failed,  0),
          'pending', COALESCE(ac.pending, 0)
        )
      ),
      'title',               p.title,
      'summary',             p.summary,
      'motivation',          p.motivation,
      'design',              p.design,
      'drawbacks',           p.drawbacks,
      'alternatives',        p.alternatives,
      'dependency',          p.dependency,
      'acceptance_criteria', COALESCE(ac.items,       '[]'::jsonb),
      'dependencies',        COALESCE(deps.items,     '[]'::jsonb),
      'discussions',         COALESCE(disc.items,     '[]'::jsonb),
      'reviews',             jsonb_build_object(
                               'items',       COALESCE(rev.items,  '[]'::jsonb),
                               'approved',    COALESCE(rev.any_approve, false),
                               'has_blocker', COALESCE(rev.has_blocker, false)
                             ),
      'timeline',            COALESCE(tl.items,       '[]'::jsonb),
      'audit',               COALESCE(p.audit,        '[]'::jsonb)
    ) AS full_document
  FROM roadmap.proposal p
  LEFT JOIN roadmap.proposal          par  ON par.id  = p.parent_id
  LEFT JOIN ac_agg                    ac   ON ac.proposal_id   = p.id
  LEFT JOIN deps_agg                  deps ON deps.proposal_id = p.id
  LEFT JOIN disc_agg                  disc ON disc.proposal_id = p.id
  LEFT JOIN review_agg                rev  ON rev.proposal_id  = p.id
  LEFT JOIN timeline_agg              tl   ON tl.proposal_id   = p.id;
