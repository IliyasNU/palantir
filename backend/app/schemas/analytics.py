from datetime import date

from pydantic import BaseModel


class SalesMetrics(BaseModel):
    sold: int
    checked_in: int
    gross_before_discount_tiyn: int
    discounts_tiyn: int
    gross_sales_tiyn: int
    refunds_tiyn: int
    net_sales_tiyn: int
    processing_fees_tiyn: int
    estimated_payout_tiyn: int


class DailySales(SalesMetrics):
    date: date


class TicketTypeSales(SalesMetrics):
    id: int
    name: str


class CampaignSales(TicketTypeSales):
    redemptions: int


class EventAnalyticsRead(SalesMetrics):
    event_id: int
    event_title: str
    capacity: int
    remaining: int
    percent_sold: float
    absent: int
    percent_checked_in: float
    daily: list[DailySales]
    ticket_types: list[TicketTypeSales]
    campaigns: list[CampaignSales]
