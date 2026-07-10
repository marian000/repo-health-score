<?php

declare(strict_types=1);

namespace CleanFixture;

final class Mailer
{
    /**
     * Delivers a message and reports whether it left.
     */
    public function send(string $message): bool
    {
        return $this->transport->deliver($message);
    }
}
