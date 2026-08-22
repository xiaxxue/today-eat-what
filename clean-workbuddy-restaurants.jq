def clean_text:
  gsub("^[[:space:]]+|[[:space:]]+$"; "")
  | gsub("[[:space:]]+"; " ");

{
  schema_version: 1,
  source: "workbuddy",
  distance_origin: {
    name: (.distance_origin.name // .distanceOrigin.name // null),
    unit: (.distance_origin.unit // .distanceOrigin.unit // "m")
  },
  restaurants: [
    .restaurants[]
    | {
        legacy_id: (.id | clean_text),
        name: (.name | clean_text),
        category: (.type | clean_text),
        avg_price_yuan: .price,
        distance_m: .distance,
        tags: ([.tags[]? | clean_text | select(length > 0)] | unique),
        enabled: .isAvailable,
        confirmed_count: .selectCount,
        source: "workbuddy",
        created_at: .createdAt
      }
  ] | sort_by(.distance_m, .name)
}
