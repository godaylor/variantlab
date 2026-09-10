import { ReviewClient } from "@/variantlab/review-client";
import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function ReviewPage() { return <ReviewClient />; }
