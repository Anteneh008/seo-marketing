import { PricingTable } from "@clerk/nextjs";
import React from "react";

function PricingPage() {
  return (
    <div>
      PricingPage
      <PricingTable newSubscriptionRedirectUrl="/dashboard" />
    </div>
  );
}

export default PricingPage;
