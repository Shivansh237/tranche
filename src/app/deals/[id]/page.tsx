import { notFound } from "next/navigation";
import { z } from "zod";
import { loadDealView, type DealViewJson } from "@/lib/engine/deal-view";
import { Dashboard } from "./dashboard";

export const dynamic = "force-dynamic";

export default async function DealPage(props: { params: Promise<{ id: string }>; searchParams: Promise<{ funded?: string }> }) {
  const [{ id }, { funded }] = await Promise.all([props.params, props.searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  const view = await loadDealView(id);
  if (!view) notFound();
  const initial = JSON.parse(JSON.stringify(view)) as DealViewJson;
  return <Dashboard initial={initial} justFunded={funded === "1"} />;
}
