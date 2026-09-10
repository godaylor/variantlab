UPDATE upload_sessions
SET completed_parts=(
 SELECT jsonb_agg(part ORDER BY (part->>'part_number')::integer)
 FROM (
  SELECT part FROM jsonb_array_elements(completed_parts) AS part
  WHERE part->>'part_number' <> $3::jsonb->>'part_number'
  UNION ALL SELECT $3::jsonb
 ) receipts
),updated_at=now()
WHERE tenant_id=$1 AND id=$2 AND state='uploading' AND expires_at>now()
