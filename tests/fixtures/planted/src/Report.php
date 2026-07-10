<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Report
{
    public function generate(): string
    {
        return implode("\n", $this->rows);
    }
}
