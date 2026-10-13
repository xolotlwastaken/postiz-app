import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';

// Headless image variant: IDs use exact-match Keyword attributes so Temporal
// can use PostgreSQL visibility without an Elasticsearch service. Keep this
// static: workflow code must not read process.env when it replays.
export const organizationId = defineSearchAttributeKey('organizationId', SearchAttributeType.KEYWORD);
export const postId = defineSearchAttributeKey('postId', SearchAttributeType.KEYWORD);
