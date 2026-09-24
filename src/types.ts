export interface PostLink {
  text: string;
  url: string;
}

import type { AuthorReputation } from "./parsers/reputation.js";

export interface ThreadPost {
  author: string;
  date: string;
  content: string;
  postNumber: number;
  links: PostLink[];
  images: string[];
  reputation?: AuthorReputation;
}

export interface ThreadData {
  title: string;
  posts: ThreadPost[];
  currentPage: number;
  totalPages: number;
  url: string;
}

export interface CodeBlock {
  code: string;
  language: string;
  context?: string;
  postId?: string;
}
