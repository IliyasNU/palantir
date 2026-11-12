"""Coded demo fees. The buyer pays the ticket price, fees reduce organizer proceeds."""
PAID_SALES_ACTIVATION_FEE_TIYN = 500_000
PAYMENT_PROCESSING_FEE_BPS = 300
DEMO_NOTICE = "Демонстрационная оплата, деньги не списываются"


def processing_fee(amount_tiyn: int, basis_points: int = PAYMENT_PROCESSING_FEE_BPS) -> int:
    """Round to nearest integer tiyn, ties upwards. Never use floating point."""
    return (amount_tiyn * basis_points + 5_000) // 10_000
