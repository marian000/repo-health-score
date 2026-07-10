<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Order
{
    public const MAX_LINE_ITEMS = 500;

    private function reset(): void
    {
        $this->state = [];
    }
}
