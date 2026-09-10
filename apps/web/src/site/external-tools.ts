import { OcDataBuddyIcon, OcMarbleIcon } from "@/components/icons";

export type ExternalTool = {
	name: string;
	description: string;
	url: string;
	icon: React.ElementType;
};

export const EXTERNAL_TOOLS: ExternalTool[] = [
	{
		name: "Marble",
		description:
			"Modern headless CMS used by the VariantLab content site",
		url: "https://marblecms.com?utm_source=variantlab",
		icon: OcMarbleIcon,
	},
	{
		name: "Databuddy",
		description: "GDPR-compliant analytics used by VariantLab",
		url: "https://databuddy.cc?utm_source=variantlab",
		icon: OcDataBuddyIcon,
	},
];
